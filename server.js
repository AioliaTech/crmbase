// server.js
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1); // se estiver atrás de proxy/CDN
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Configuração PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'n8n_postgres',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASSWORD || '1dbf27c30ea64a151990',
  port: process.env.DB_PORT || 5432,
});

// Configuração ZapperAPI
const ZAPPER_CONFIG = {
  apiUrl: 'https://api.zapperapi.com',
  instanceId: process.env.ZAPPER_INSTANCE_ID,
  apiKey: process.env.ZAPPER_API_KEY
};

// Upload (temporário antes de mover para /public/uploads)
const upload = multer({ dest: 'temp/' });

// Criar tabelas se não existirem
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_conversations (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        name VARCHAR(255),
        last_message_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES crm_conversations(id),
        message_id VARCHAR(255) UNIQUE,
        sender_phone VARCHAR(20),
        message_text TEXT,
        message_type VARCHAR(20) DEFAULT 'text',
        media_url VARCHAR(500),
        media_filename VARCHAR(255),
        is_from_me BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMP DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'received'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS crm_webhook_config (
        id SERIAL PRIMARY KEY,
        webhook_url VARCHAR(500) NOT NULL,
        secret_token VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('✅ Banco de dados inicializado');
  } catch (error) {
    console.error('❌ Erro ao inicializar BD:', error);
  }
}

// helper
function fileNameFromUrl(u) {
  try { return new URL(u).pathname.split('/').pop(); } catch { return null; }
}

// Webhook para receber mensagens da ZapperAPI
app.post('/webhook/zapper', async (req, res) => {
  try {
    console.log('📱 Webhook recebido da ZapperAPI:', JSON.stringify(req.body, null, 2));

    const data = req.body;
    const webhookData = Array.isArray(data) ? data[0] : data;
    const body = webhookData.body || webhookData;

    if (body.type !== 'messages.upsert') {
      console.log('⚠️ Tipo de evento ignorado:', body.type);
      return res.json({ success: true, message: 'Evento ignorado' });
    }

    const {
      key,
      messageTimestamp,
      pushName,
      message: messageObj,
      instanceId,
      mediaUrl     // URL processada pela ZapperAPI (quando houver)
    } = body;

    // timestamp pode vir como number ou {low, high}
    let timestamp;
    if (typeof messageTimestamp === 'number') {
      timestamp = new Date(messageTimestamp * 1000);
    } else if (messageTimestamp && typeof messageTimestamp === 'object' && messageTimestamp.low) {
      timestamp = new Date(messageTimestamp.low * 1000);
    } else {
      timestamp = new Date();
    }

    // Extrair número do remoteJid
    const phone = key?.remoteJid?.replace('@s.whatsapp.net', '');
    const contactName = pushName || phone;
    const messageId = key?.id;
    const fromMe = !!key?.fromMe;

    if (!phone) {
      return res.status(400).json({ error: 'Número do telefone não encontrado' });
    }

    // Ignorar mensagens enviadas por nós para evitar duplicação
    if (fromMe) {
      console.log(`⚠️ Ignorando mensagem própria: ${messageId}`);
      return res.json({ success: true, message: 'Mensagem própria ignorada' });
    }

    // Extrair texto/tipo e URL da mídia (se houver)
    let messageText = '';
    let messageType = 'text';
    let finalMediaUrl = null;

    if (messageObj?.conversation) {
      messageText = messageObj.conversation;
    } else if (messageObj?.extendedTextMessage) {
      messageText = messageObj.extendedTextMessage.text;
    } else if (messageObj?.imageMessage) {
      messageType = 'image';
      messageText = messageObj.imageMessage.caption || '';
      finalMediaUrl = mediaUrl || messageObj.imageMessage.url || null;
      console.log('📷 Imagem recebida:', {
        originalUrl: messageObj.imageMessage.url,
        zapperMediaUrl: mediaUrl,
        finalUrl: finalMediaUrl
      });
    } else if (messageObj?.videoMessage) {
      messageType = 'video';
      messageText = messageObj.videoMessage.caption || '';
      finalMediaUrl = mediaUrl || messageObj.videoMessage.url || null;
    } else if (messageObj?.audioMessage) {
      messageType = 'audio';
      messageText = '';
      finalMediaUrl = mediaUrl || messageObj.audioMessage.url || null;
    } else if (messageObj?.documentMessage) {
      messageType = 'document';
      messageText = messageObj.documentMessage.fileName || 'Documento';
      finalMediaUrl = mediaUrl || messageObj.documentMessage.url || null;
    } else {
      messageText = 'Mensagem não suportada';
      console.log('Tipo de mensagem desconhecido:', Object.keys(messageObj || {}));
    }

    // Buscar ou criar conversa
    let conversation = await pool.query(
      'SELECT * FROM crm_conversations WHERE phone = $1',
      [phone]
    );

    if (conversation.rows.length === 0) {
      const newConv = await pool.query(
        'INSERT INTO crm_conversations (phone, name) VALUES ($1, $2) RETURNING *',
        [phone, contactName]
      );
      conversation = newConv;
    } else {
      await pool.query(
        'UPDATE crm_conversations SET name = $1, last_message_at = NOW() WHERE phone = $2',
        [contactName, phone]
      );
    }

    const convId = conversation.rows[0].id;

    // Salvar mensagem (AGORA SALVA media_url e media_filename)
    await pool.query(`
      INSERT INTO crm_messages 
        (conversation_id, message_id, sender_phone, message_text, message_type,
         media_url, media_filename, is_from_me, timestamp)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (message_id) DO NOTHING
    `, [
      convId,
      messageId,
      phone,
      messageText || (messageType === 'image' ? '📷 Imagem' :
                      messageType === 'video' ? '🎥 Vídeo' :
                      messageType === 'audio' ? '🎵 Áudio' : 'Mensagem'),
      messageType,
      finalMediaUrl,
      fileNameFromUrl(finalMediaUrl),
      fromMe,
      timestamp
    ]);

    console.log(`📱 Nova mensagem de ${contactName} (${phone}): ${messageText}`);
    res.json({ success: true, message: 'Webhook processado com sucesso' });
  } catch (error) {
    console.error('❌ Erro no webhook ZapperAPI:', error);
    res.status(500).json({ error: error.message });
  }
});

// API para buscar conversas
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, COUNT(m.id) as message_count
      FROM crm_conversations c
      LEFT JOIN crm_messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY c.last_message_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para buscar mensagens de uma conversa
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT * FROM crm_messages 
      WHERE conversation_id = $1 
      ORDER BY timestamp ASC
    `, [id]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para enviar mensagem via ZapperAPI
app.post('/api/send-message', async (req, res) => {
  try {
    const { phone, message, messageType = 'text', mediaUrl } = req.body;

    if (!ZAPPER_CONFIG.instanceId || !ZAPPER_CONFIG.apiKey) {
      return res.status(500).json({
        error: 'Configuração da ZapperAPI não encontrada. Verifique ZAPPER_INSTANCE_ID e ZAPPER_API_KEY'
      });
    }

    // Formatar número no padrão WhatsApp
    let jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

    let zapperUrl, payload;

    if (messageType !== 'text' && mediaUrl) {
      // Envio de mídia
      zapperUrl = `${ZAPPER_CONFIG.apiUrl}/${ZAPPER_CONFIG.instanceId}/messages/media`;

      let zapperMediaType = messageType; // image, video, audio, document
      payload = {
        jid,
        mediaType: zapperMediaType,
        media: mediaUrl,             // URL pública do arquivo
        caption: message || '',
        filename: `media_${Date.now()}.${messageType === 'image' ? 'jpg' : 'file'}`,
        mentions: [],
        mentionsEveryone: false
      };
    } else {
      // Envio de texto
      zapperUrl = `${ZAPPER_CONFIG.apiUrl}/${ZAPPER_CONFIG.instanceId}/messages/text`;
      payload = {
        jid,
        message,
        mentions: [],
        mentionsEveryone: false,
        splitMessage: false,
        processImageLink: true,
        autoCaption: false,
        expiration: "none"
      };
    }

    const response = await axios.post(zapperUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': ZAPPER_CONFIG.apiKey
      },
      timeout: 30000
    });

    // Garantir conversa no BD
    let conversation = await pool.query('SELECT * FROM crm_conversations WHERE phone = $1', [phone.replace('@s.whatsapp.net', '')]);
    if (conversation.rows.length === 0) {
      const newConv = await pool.query(
        'INSERT INTO crm_conversations (phone, name) VALUES ($1, $2) RETURNING *',
        [phone.replace('@s.whatsapp.net', ''), phone.replace('@s.whatsapp.net', '')]
      );
      conversation = newConv;
    }

    await pool.query(`
      INSERT INTO crm_messages 
        (conversation_id, message_id, sender_phone, message_text, message_type, media_url, is_from_me, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      conversation.rows[0].id,
      response.data.key || `sent_${Date.now()}`,
      phone.replace('@s.whatsapp.net', ''),
      message,
      messageType,
      mediaUrl || null,
      true,
      'sent'
    ]);

    res.json({
      success: true,
      message: 'Mensagem enviada via ZapperAPI',
      zapperResponse: response.data
    });
  } catch (error) {
    console.error('❌ Erro ao enviar via ZapperAPI:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erro ao enviar mensagem',
      details: error.response?.data || error.message
    });
  }
});

// API para configurar webhook (salva localmente; não registra na Zapper)
app.post('/api/webhook-config', async (req, res) => {
  try {
    const { webhookUrl, secretToken } = req.body;

    await pool.query(`
      INSERT INTO crm_webhook_config (webhook_url, secret_token) 
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET 
      webhook_url = $1, secret_token = $2, created_at = NOW()
    `, [webhookUrl, secretToken]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload de mídia — salva arquivo em /public/uploads e retorna URL pública
app.post('/api/upload-media', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const ext = path.extname(req.file.originalname) || '';
    const fileName = `${uuidv4()}${ext}`;
    const finalPath = path.join(uploadsDir, fileName);

    fs.renameSync(req.file.path, finalPath);

    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const mediaUrl = `${baseUrl}/uploads/${fileName}`;

    return res.json({ success: true, mediaUrl, fileName: req.file.originalname });
  } catch (error) {
    console.error('Erro no upload:', error);
    return res.status(500).json({ error: error.message });
  }
});

// API para debug - ver URLs de mídia no banco
app.get('/api/debug/media', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, message_text, message_type, media_url, timestamp 
      FROM crm_messages 
      WHERE message_type != 'text' AND media_url IS NOT NULL
      ORDER BY timestamp DESC 
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Servir a interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicializar
initDB();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📱 Webhook ZapperAPI: http://localhost:${PORT}/webhook/zapper`);
  console.log(`⚙️  Configurações necessárias:`);
  console.log(`   - ZAPPER_INSTANCE_ID: ${ZAPPER_CONFIG.instanceId || 'NÃO CONFIGURADO'}`);
  console.log(`   - ZAPPER_API_KEY: ${ZAPPER_CONFIG.apiKey ? '✅ Configurado' : '❌ NÃO CONFIGURADO'}`);
  console.log(`   - PUBLIC_BASE_URL: ${process.env.PUBLIC_BASE_URL || '(usando host da requisição)'}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});

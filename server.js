// server.js
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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

// Configuração de upload
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

// Função para upload no BucketBlaze (Backblaze B2)
async function uploadToBucket(filePath, fileName) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        
        // Por enquanto, retornar URL simulada
        // TODO: Implementar upload real para Backblaze B2 quando necessário
        const timestamp = Date.now();
        const fileUrl = `${BUCKET_CONFIG.endpoint}/${BUCKET_CONFIG.bucketName}/${timestamp}_${fileName}`;
        
        console.log(`📦 Simulando upload: ${fileName} para ${BUCKET_CONFIG.bucketName}`);
        
        // Remove arquivo temporário
        fs.unlinkSync(filePath);
        
        return fileUrl;
    } catch (error) {
        console.error('Erro no upload:', error);
        throw error;
    }
}

// Webhook para receber mensagens da ZapperAPI
app.post('/webhook/zapper', async (req, res) => {
    try {
        console.log('📱 Webhook recebido da ZapperAPI:', JSON.stringify(req.body, null, 2));
        
        const data = req.body;
        
        // A ZapperAPI envia um array, pegar o primeiro item
        const webhookData = Array.isArray(data) ? data[0] : data;
        const body = webhookData.body || webhookData;
        
        // Verificar se é mensagem de upsert
        if (body.type !== 'messages.upsert') {
            console.log('⚠️ Tipo de evento ignorado:', body.type);
            return res.json({ success: true, message: 'Evento ignorado' });
        }
        
        // Extrair dados da estrutura da ZapperAPI
        const {
            key,
            messageTimestamp,
            pushName,
            message: messageObj,
            instanceId,
            mediaUrl  // URL processada pela ZapperAPI
        } = body;
        
        // Processar timestamp que pode vir como número ou objeto {low, high}
        let timestamp;
        if (typeof messageTimestamp === 'number') {
            timestamp = new Date(messageTimestamp * 1000);
        } else if (messageTimestamp && typeof messageTimestamp === 'object' && messageTimestamp.low) {
            // Timestamp no formato {low: number, high: number}
            timestamp = new Date(messageTimestamp.low * 1000);
        } else {
            // Fallback para timestamp atual
            timestamp = new Date();
        }
        
        console.log(`🕐 Timestamp processado:`, { original: messageTimestamp, processed: timestamp });
        
        // Extrair número do remoteJid (remove @s.whatsapp.net)
        const phone = key.remoteJid.replace('@s.whatsapp.net', '');
        const contactName = pushName || phone;
        const messageId = key.id;
        const fromMe = key.fromMe;
        
        if (!phone) {
            return res.status(400).json({ error: 'Número do telefone não encontrado' });
        }
        
        // Pular mensagens enviadas por nós para evitar duplicação
        if (fromMe) {
            console.log(`⚠️ Ignorando mensagem própria para evitar duplicação: ${messageId}`);
            return res.json({ success: true, message: 'Mensagem própria ignorada' });
        }
        
        // Extrair texto da mensagem baseado no tipo
        let messageText = '';
        let messageType = 'text';
        let finalMediaUrl = null;
        
        if (messageObj.conversation) {
            // Mensagem de texto simples
            messageText = messageObj.conversation;
        } else if (messageObj.extendedTextMessage) {
            // Mensagem de texto estendida (com contexto, quote, etc.)
            messageText = messageObj.extendedTextMessage.text;
        } else if (messageObj.imageMessage) {
            messageType = 'image';
            messageText = messageObj.imageMessage.caption || '';
            // Priorizar mediaUrl da ZapperAPI, que já está processada e acessível
            finalMediaUrl = mediaUrl || null;
            console.log('📷 Imagem recebida:', {
                originalUrl: messageObj.imageMessage.url,
                zapperMediaUrl: mediaUrl,
                finalUrl: finalMediaUrl
            });
        } else if (messageObj.videoMessage) {
            messageType = 'video';
            messageText = messageObj.videoMessage.caption || '';
            finalMediaUrl = mediaUrl || null;
        } else if (messageObj.audioMessage) {
            messageType = 'audio';
            messageText = '';
            finalMediaUrl = mediaUrl || null;
        } else if (messageObj.documentMessage) {
            messageType = 'document';
            messageText = messageObj.documentMessage.fileName || 'Documento';
            finalMediaUrl = mediaUrl || messageObj.documentMessage.url;
        } else {
            // Tipo desconhecido
            messageText = 'Mensagem não suportada';
            console.log('Tipo de mensagem desconhecido:', Object.keys(messageObj));
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
            // Atualizar nome e última mensagem
            await pool.query(
                'UPDATE crm_conversations SET name = $1, last_message_at = NOW() WHERE phone = $2',
                [contactName, phone]
            );
        }
        
        const convId = conversation.rows[0].id;
        
        // Salvar mensagem no banco
        await pool.query(`
            INSERT INTO crm_messages 
            (conversation_id, message_id, sender_phone, message_text, message_type, is_from_me, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (message_id) DO NOTHING
        `, [
            convId, 
            messageId, 
            phone, 
            messageText, 
            messageType,
            fromMe,
            timestamp // Usar timestamp processado
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
        
        // Formatar número no padrão do WhatsApp 
        let jid;
        if (phone.includes('@')) {
            jid = phone;
        } else {
            jid = `${phone}@s.whatsapp.net`;
        }
        
        console.log(`📱 Número original: ${phone}`);
        console.log(`📱 JID formatado: ${jid}`);
        
        let zapperUrl, payload;
        
        // Diferentes endpoints baseado no tipo de mensagem
        if (messageType !== 'text' && mediaUrl) {
            // Envio de mídia usando endpoint /messages/media
            zapperUrl = `${ZAPPER_CONFIG.apiUrl}/${ZAPPER_CONFIG.instanceId}/messages/media`;
            
            // Mapear tipos para mediaType da ZapperAPI
            let zapperMediaType = messageType;
            if (messageType === 'document') zapperMediaType = 'document';
            
            payload = {
                jid: jid,
                mediaType: zapperMediaType,  // image, video, audio, document
                media: mediaUrl,             // URL da mídia (do BucketBlaze)
                caption: message || '',
                filename: `media_${Date.now()}.${messageType === 'image' ? 'jpg' : 'file'}`,
                mentions: [],
                mentionsEveryone: false
            };
        } else {
            // Envio de texto usando endpoint /messages/text
            zapperUrl = `${ZAPPER_CONFIG.apiUrl}/${ZAPPER_CONFIG.instanceId}/messages/text`;
            payload = {
                jid: jid,
                message: message,
                mentions: [],
                mentionsEveryone: false,
                splitMessage: false,
                processImageLink: true,
                autoCaption: false,
                expiration: "none"
            };
        }
        
        console.log(`📤 Enviando para ZapperAPI:`);
        console.log(`URL: ${zapperUrl}`);
        console.log(`JID: ${jid}`);
        console.log(`Message: ${message}`);
        console.log(`Type: ${messageType}`);
        console.log(`Instance ID: ${ZAPPER_CONFIG.instanceId}`);
        console.log(`API Key starts with: ${ZAPPER_CONFIG.apiKey?.substring(0, 10)}...`);
        
        // Enviar via ZapperAPI com headers corretos
        const response = await axios.post(zapperUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': ZAPPER_CONFIG.apiKey
            },
            timeout: 30000 // 30 segundos de timeout
        });
        
        console.log(`✅ Resposta da ZapperAPI:`, response.data);
        
        // Salvar mensagem enviada no banco
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

// API para configurar webhook
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

// Upload de mídia - versão simplificada
app.post('/api/upload-media', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }
        
        // Por enquanto, converter para base64 e enviar diretamente pela ZapperAPI
        const fileBuffer = fs.readFileSync(req.file.path);
        const base64 = fileBuffer.toString('base64');
        const mimeType = req.file.mimetype;
        
        // Remove arquivo temporário
        fs.unlinkSync(req.file.path);
        
        // Retornar base64 para usar diretamente no envio
        res.json({ 
            success: true, 
            mediaBase64: base64,
            mimeType: mimeType,
            fileName: req.file.originalname 
        });
        
    } catch (error) {
        console.error('Erro no upload:', error);
        res.status(500).json({ error: error.message });
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
});

// Tratar fechamento graceful
process.on('SIGINT', async () => {
    await pool.end();
    process.exit(0);
});

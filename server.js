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

// Configuração BucketBlaze (Backblaze B2)
const BUCKET_CONFIG = {
    endpoint: process.env.BLAZE_ENDPOINT_URL || 'https://s3.us-west-004.backblazeb2.com',
    accessKey: process.env.BLAZE_ACCESS_KEY || '0052da03b06eb430000000001',
    secretKey: process.env.BLAZE_SECRET_KEY || 'K005hvxNotXi1CiNxc+DAbdrzDXjQbE',
    bucketName: process.env.BLAZE_BUCKET_NAME || 'Integrador'
};

// Configuração de upload
const upload = multer({ dest: 'temp/' });

// Configuração ZapperAPI
const ZAPPER_CONFIG = {
    apiUrl: 'https://api.zapperapi.com',
    instanceId: process.env.ZAPPER_INSTANCE_ID,
    apiKey: process.env.ZAPPER_API_KEY
};

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
        
        // Implementação básica para Backblaze B2
        // Você pode usar a biblioteca oficial aws-sdk ou b2-sdk-js
        const fileUrl = `${BUCKET_CONFIG.endpoint}/${BUCKET_CONFIG.bucketName}/${fileName}`;
        
        // TODO: Implementar upload real para Backblaze B2
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
            instanceId
        } = body;
        
        // Extrair número do remoteJid (remove @s.whatsapp.net)
        const phone = key.remoteJid.replace('@s.whatsapp.net', '');
        const contactName = pushName || phone;
        const messageId = key.id;
        const fromMe = key.fromMe;
        
        if (!phone) {
            return res.status(400).json({ error: 'Número do telefone não encontrado' });
        }
        
        // Extrair texto da mensagem baseado no tipo
        let messageText = '';
        let messageType = 'text';
        
        if (messageObj.conversation) {
            // Mensagem de texto simples
            messageText = messageObj.conversation;
        } else if (messageObj.extendedTextMessage) {
            // Mensagem de texto estendida (com contexto, quote, etc.)
            messageText = messageObj.extendedTextMessage.text;
        } else if (messageObj.imageMessage) {
            messageType = 'image';
            messageText = messageObj.imageMessage.caption || '📷 Imagem';
        } else if (messageObj.videoMessage) {
            messageType = 'video';
            messageText = messageObj.videoMessage.caption || '🎥 Vídeo';
        } else if (messageObj.audioMessage) {
            messageType = 'audio';
            messageText = '🎵 Áudio';
        } else if (messageObj.documentMessage) {
            messageType = 'document';
            messageText = `📎 ${messageObj.documentMessage.fileName || 'Documento'}`;
        } else {
            // Tipo desconhecido
            messageText = '📎 Mensagem não suportada';
            console.log('🔍 Tipo de mensagem desconhecido:', Object.keys(messageObj));
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
            new Date(messageTimestamp * 1000) // Converter timestamp Unix para Date
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
        const { phone, message, messageType = 'text' } = req.body;
        
        if (!ZAPPER_CONFIG.instanceId || !ZAPPER_CONFIG.apiKey) {
            return res.status(500).json({ 
                error: 'Configuração da ZapperAPI não encontrada. Verifique ZAPPER_INSTANCE_ID e ZAPPER_API_KEY' 
            });
        }
        
        // Formatar número no padrão do WhatsApp (adicionar @c.us se necessário)
        const jid = phone.includes('@') ? phone : `${phone}@c.us`;
        
        // Montar URL da ZapperAPI
        const zapperUrl = `${ZAPPER_CONFIG.apiUrl}/${ZAPPER_CONFIG.instanceId}/messages/text`;
        
        // Payload para ZapperAPI
        const payload = {
            jid: jid,
            message: message,
            mentions: [],
            mentionsEveryone: false,
            splitMessage: false,
            processImageLink: true,
            autoCaption: false,
            expiration: "none"
        };
        
        console.log(`📤 Enviando para ZapperAPI:`, { url: zapperUrl, payload });
        
        // Enviar via ZapperAPI
        const response = await axios.post(zapperUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': ZAPPER_CONFIG.apiKey
            }
        });
        
        console.log(`✅ Resposta da ZapperAPI:`, response.data);
        
        // Salvar mensagem enviada no banco
        let conversation = await pool.query('SELECT * FROM crm_conversations WHERE phone = $1', [phone.replace('@c.us', '')]);
        if (conversation.rows.length === 0) {
            const newConv = await pool.query(
                'INSERT INTO crm_conversations (phone, name) VALUES ($1, $2) RETURNING *',
                [phone.replace('@c.us', ''), phone.replace('@c.us', '')]
            );
            conversation = newConv;
        }
        
        await pool.query(`
            INSERT INTO crm_messages 
            (conversation_id, message_id, sender_phone, message_text, message_type, is_from_me, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            conversation.rows[0].id, 
            response.data.key || `sent_${Date.now()}`, 
            phone.replace('@c.us', ''), 
            message, 
            messageType, 
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

// Upload de mídia
app.post('/api/upload-media', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }
        
        const fileName = `${Date.now()}_${req.file.originalname}`;
        const mediaUrl = await uploadToBucket(req.file.path, fileName);
        
        res.json({ 
            success: true, 
            mediaUrl, 
            fileName: req.file.originalname 
        });
        
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

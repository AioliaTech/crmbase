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

// Webhook para receber mensagens do WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const { phone, message, messageId, messageType, mediaUrl, fileName, fromMe } = req.body;
        
        // Buscar ou criar conversa
        let conversation = await pool.query(
            'SELECT * FROM crm_conversations WHERE phone = $1',
            [phone]
        );
        
        if (conversation.rows.length === 0) {
            const newConv = await pool.query(
                'INSERT INTO crm_conversations (phone, name) VALUES ($1, $2) RETURNING *',
                [phone, phone]
            );
            conversation = newConv;
        } else {
            // Atualizar última mensagem
            await pool.query(
                'UPDATE crm_conversations SET last_message_at = NOW() WHERE phone = $1',
                [phone]
            );
        }
        
        const convId = conversation.rows[0].id;
        
        // Salvar mensagem
        await pool.query(`
            INSERT INTO crm_messages 
            (conversation_id, message_id, sender_phone, message_text, message_type, media_url, media_filename, is_from_me)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [convId, messageId, phone, message, messageType, mediaUrl, fileName, fromMe]);
        
        console.log(`📱 Nova mensagem de ${phone}: ${message || 'mídia'}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Erro no webhook:', error);
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

// API para enviar mensagem
app.post('/api/send-message', async (req, res) => {
    try {
        const { phone, message, messageType = 'text' } = req.body;
        
        // Aqui você faria a chamada para sua API do WhatsApp
        // const response = await axios.post('SUA_API_WHATSAPP/send', {
        //     phone, message, messageType
        // });
        
        // Simular envio por enquanto
        console.log(`📤 Enviando para ${phone}: ${message}`);
        
        // Salvar mensagem enviada no banco
        let conversation = await pool.query('SELECT * FROM crm_conversations WHERE phone = $1', [phone]);
        if (conversation.rows.length === 0) {
            const newConv = await pool.query(
                'INSERT INTO crm_conversations (phone, name) VALUES ($1, $2) RETURNING *',
                [phone, phone]
            );
            conversation = newConv;
        }
        
        await pool.query(`
            INSERT INTO crm_messages 
            (conversation_id, sender_phone, message_text, message_type, is_from_me, status)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [conversation.rows[0].id, phone, message, messageType, true, 'sent']);
        
        res.json({ success: true, message: 'Mensagem enviada' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
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
    console.log(`📱 Webhook endpoint: http://localhost:${PORT}/webhook/whatsapp`);
});

// Tratar fechamento graceful
process.on('SIGINT', async () => {
    await pool.end();
    process.exit(0);
});

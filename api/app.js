require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
const fetch = require('node-fetch');

// Supabase Admin Client
const supabaseUrl = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const port = process.env.PORT || 3000;

const supabaseKey = process.env.SUPABASE_KEY || 'dummy_key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Debug Route to verify ENV and Status
app.get('/api/debug', (req, res) => {
    res.json({
        status: 'online',
        has_gemini_key: !!process.env.GEMINI_API_KEY,
        node_version: process.version,
        env: process.env.NODE_ENV || 'development'
    });
});

// Webhook endpoint needs raw body for Stripe signature verification
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const payload = req.body;
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        if (endpointSecret) {
            event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
        } else {
            event = JSON.parse(payload.toString());
            console.warn('⚠️ Webhook secret not set. Skipping signature verification.');
        }
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const customerEmail = session.customer_details?.email;
        if (userId) {
            try {
                await supabaseAdmin.from('profiles').upsert({
                    id: userId,
                    email: customerEmail,
                    plan: 'premium',
                    credits: 9999,
                    updated_at: new Date().toISOString()
                });
            } catch (dbError) {
                console.error('Exceção ao atualizar Supabase:', dbError);
            }
        }
    }
    res.status(200).end();
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

if (process.env.NODE_ENV !== 'production') {
    app.use(express.static(path.join(__dirname, '../')));
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nutrik.AI Backend is running' });
});

app.post('/api/checkout-session', async (req, res) => {
    try {
        const { email, userId } = req.body;
        if (!email || !userId) return res.status(400).json({ error: 'Email and UserId are required' });
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            client_reference_id: userId,
            line_items: [{
                price_data: {
                    currency: 'brl',
                    product_data: {
                        name: 'Nutrik.IA Premium',
                        description: 'Acesso total, passes livres e análise de humor.',
                    },
                    unit_amount: 5700,
                    recurring: { interval: 'month' }
                },
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/chat.html?success=true`,
            cancel_url: `${req.protocol}://${req.get('host')}/plans.html?canceled=true`,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Nutrik.IA Chat Endpoint (Universal Direct Fetch Version)
app.post('/api/chat', async (req, res) => {
    console.log('[API CHAT] Chamando Google API diretamente...');
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem é obrigatória' });

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(401).json({
                error: 'Configuração Incompleta',
                details: 'A chave GEMINI_API_KEY não foi encontrada no servidor Vercel. Por favor, adicione-a nas variáveis de ambiente.'
            });
        }

        // Switching to the stable v1 endpoint and the most compatible model name
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

        // Construct contents
        let contents = [];
        if (history && Array.isArray(history)) {
            history.forEach(h => {
                if (h.text) {
                    contents.push({
                        role: h.role === 'model' || h.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: h.text }]
                    });
                }
            });
        }

        let currentParts = [];
        if (message) currentParts.push({ text: message });

        if (imageBase64) {
            const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                if (!message) currentParts.push({ text: "Analise esta imagem detalhadamente, dando gramas estimadas e o total de Macronutrientes (Proteína, Carboidrato, Gordura) e Calorias. Use <strong> para destacar números." });
                currentParts.push({
                    inlineData: {
                        mimeType: matches[1],
                        data: matches[2]
                    }
                });
            }
        } else if (!message) {
            currentParts.push({ text: "Olá!" });
        }

        contents.push({ role: 'user', parts: currentParts });

        const requestBody = {
            contents: contents,
            systemInstruction: {
                parts: [{ text: "Você é o Nutrik.IA, assistente nutricional parceiro. Analise fotos, estime gramas e informe macros exatos usando <strong> em números. Seja amigável e técnico." }]
            },
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 1024
            }
        };

        const fetchResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await fetchResponse.json();

        if (!fetchResponse.ok) {
            console.error('[API CHAT] Google Error Response:', data);
            return res.status(fetchResponse.status).json({
                error: 'Erro na IA do Google',
                details: data.error?.message || JSON.stringify(data)
            });
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            res.json({ reply: data.candidates[0].content.parts[0].text });
        } else if (data.promptFeedback) {
            res.json({ reply: "Desculpe, a IA não pôde processar essa imagem por motivos de segurança do Google (Filtro de Conteúdo). Tente outra foto!" });
        } else {
            throw new Error('Resposta do Google sem conteúdo válido.');
        }

    } catch (error) {
        console.error('Error in Gemini Chat:', error);
        res.status(500).json({
            error: 'Erro técnico interno no servidor.',
            details: error.message
        });
    }
});

if (require.main === module) {
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

module.exports = app;

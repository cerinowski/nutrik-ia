require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Supabase Admin Client
const supabaseUrl = process.env.SUPABASE_URL || 'https://aoejmzgcgvvtyokfvubn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

// Initialize Google Generative AI with the API Key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const app = express();
const port = process.env.PORT || 3000;

const supabaseKey = process.env.SUPABASE_KEY || 'dummy_key';
const supabase = createClient(supabaseUrl, supabaseKey);

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

// Chat Endpoint using OFFICIAL SDK
app.post('/api/chat', async (req, res) => {
    console.log('[API CHAT] Chamando Google API via SDK Oficial...');
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem é obrigatória' });

        // Get the model (using 1.5-flash as the stable standard for vision)
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: "Você é o Nutrik.IA, assistente nutricional parceiro. Analise fotos, estime gramas e informe macros exatos usando <strong> em números. Seja amigável e técnico."
        });

        // Format history for the SDK
        let chatHistory = [];
        if (history && Array.isArray(history)) {
            chatHistory = history.map(h => ({
                role: h.role === 'model' || h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.text }]
            }));
        }

        const chat = model.startChat({
            history: chatHistory,
            generationConfig: {
                maxOutputTokens: 1024,
                temperature: 0.3,
            },
        });

        // Construct current message parts
        let currentParts = [];
        if (message) {
            currentParts.push({ text: message });
        }

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

        const result = await chat.sendMessage(currentParts);
        const response = await result.response;
        const text = response.text();

        res.json({ reply: text });

    } catch (error) {
        console.error('Error in Gemini SDK Chat:', error);

        let errorMessage = 'Erro técnico de conexão com a IA.';
        let details = error.message;

        if (error.message.includes('429') || error.message.toLowerCase().includes('quota')) {
            errorMessage = 'Opa! O cérebro da IA atingiu o limite grátis do Google. Espere 60s e tente de novo! ⏳';
        } else if (error.message.includes('404')) {
            errorMessage = 'Modelo não encontrado. Verificando configuração...';
        }

        res.status(500).json({
            error: errorMessage,
            details: details
        });
    }
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

if (require.main === module) {
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

module.exports = app;

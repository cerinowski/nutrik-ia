require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');

// Supabase Admin Client
const supabaseUrl = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

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
    app.use(express.static(path.join(__dirname, '../public')));
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

// Nutrik.IA Chat Endpoint (Direct Google API Fetch Version)
app.post('/api/chat', async (req, res) => {
    console.log('[API CHAT] Recebendo requisição (Direct Google Fetch)...');
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem é obrigatória' });

        const apiKey = process.env.GEMINI_API_KEY || '';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        // Construct contents according to Google AI schema
        let contents = [];

        // Add Chat History
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

        // Add Current Message
        let currentParts = [];
        if (message) {
            currentParts.push({ text: message });
        }

        if (imageBase64) {
            const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                // Reinforce macro instructions if imaging
                if (!message) currentParts.push({ text: "Analise esta refeição detalhadamente, dando gramas estimadas de cada item e o total de Macronutrientes (Proteína, Carboidrato, Gordura) e Calorias. Use <strong> para destacar valores numéricos." });

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
                parts: [{ text: "Você é o Nutrik.IA, um assistente nutricional amigável, ágil e técnico. Filtre alimentos em fotos, estime gramas e informe macronutrientes exatos usando <strong> para destacar números. Responda como uma conversa natural." }]
            },
            generationConfig: {
                temperature: 0.4,
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 1024,
            }
        };

        const fetchResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await fetchResponse.json();

        if (!fetchResponse.ok) {
            console.error('[API CHAT] Erro Google Direct:', JSON.stringify(data, null, 2));
            if (fetchResponse.status === 429) {
                return res.status(429).json({ error: 'Opa! O cérebro da IA atingiu o limite grátis do Google. Espere 60s e tente de novo! ⏳' });
            }
            throw new Error(data.error?.message || 'Erro na comunicação direta com Google');
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            const reply = data.candidates[0].content.parts[0].text;
            res.json({ reply: reply });
        } else {
            console.error('[API CHAT] Estrutura de resposta inesperada:', data);
            throw new Error('Google não retornou uma resposta válida.');
        }

    } catch (error) {
        console.error('Error in Direct Gemini Chat:', error);
        res.status(500).json({
            error: 'Erro técnico de conexão com a IA. Tente atualizar a página.',
            details: error.message
        });
    }
});

if (require.main === module) {
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

module.exports = app;

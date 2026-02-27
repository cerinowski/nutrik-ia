require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');

// Using OpenAI-compatible endpoint for Gemini (more stable for this environment)
const geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';

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

// Nutrik.IA Chat Endpoint
app.post('/api/chat', async (req, res) => {
    console.log('[API CHAT] Recebendo requisição (Fetch Mode)...');
    try {
        const { message, imageBase64, history } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem é obrigatória' });

        const systemPrompt = `Você é o Nutrik.IA, um assistente nutricional amigável e técnico.
        MUITO IMPORTANTE: Para fotos de comida, liste gramas estimadas e macronutrientes (Proteínas, Carboidratos, Gorduras e Calorias). 
        Use <strong> para valores. Force uma estimativa técnica realista.`;

        let messages = [{ role: 'system', content: systemPrompt }];

        if (history && Array.isArray(history)) {
            history.forEach(h => {
                if (h.text) {
                    messages.push({
                        role: h.role === 'model' || h.role === 'assistant' ? 'assistant' : 'user',
                        content: h.text
                    });
                }
            });
        }

        let userContent = [];
        if (message) userContent.push({ type: 'text', text: message });

        if (imageBase64) {
            const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                userContent.push({ type: 'text', text: "Analise esta imagem detalhadamente, dando pesos e macros." });
                userContent.push({ type: 'image_url', image_url: { url: imageBase64 } });
            }
        } else if (!message) {
            userContent.push({ type: 'text', text: "Analise esta imagem detalhadamente, dando pesos e macros." });
        }

        messages.push({ role: 'user', content: userContent });

        const apiKey = process.env.GEMINI_API_KEY || '';
        const fetchResponse = await fetch(`${geminiBaseUrl}chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gemini-1.5-flash',
                messages: messages,
                temperature: 0.3,
                max_tokens: 1000
            })
        });

        const data = await fetchResponse.json();

        if (!fetchResponse.ok) {
            console.error('[API CHAT] Erro Gemini:', data);

            // Handle Rate Limit specifically
            if (fetchResponse.status === 429) {
                return res.status(429).json({
                    error: 'Opa! O cérebro da IA está respirando no momento (limite de uso grátis atingido). Espere 60s e tente novamente! ⏳'
                });
            }

            return res.status(fetchResponse.status).json({
                error: 'Erro técnico na IA',
                details: data.error?.message || 'Erro desconhecido'
            });
        }

        res.json({ reply: data.choices[0].message.content });

    } catch (error) {
        console.error('Error in Chat:', error);
        res.status(500).json({
            error: 'Erro de conexão interna. Tente atualizar a página.',
            details: error.message
        });
    }
});

if (require.main === module) {
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
}

module.exports = app;

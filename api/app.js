require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
const OpenAI = require('openai');

// Using native fetch for Gemini instead of OpenAI SDK module
const geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';

// Supabase Admin Client (to bypass RLS for webhook updates)
// We will use the service_role key for this.
const supabaseUrl = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key'; // Fallback to anon if service key not provided, though service key is needed for bypass
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase Client
// Remove duplicate declaration
const supabaseKey = process.env.SUPABASE_KEY || 'dummy_key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Webhook endpoint needs raw body for Stripe signature verification
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const payload = req.body;
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        // If you don't have an endpoint secret yet (e.g., testing locally without Stripe CLI),
        // we can bypass signature verification for now, but it's INSECURE for production.
        if (endpointSecret) {
            event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
        } else {
            // Fallback for local testing if secret isn't set
            event = JSON.parse(payload.toString());
            console.warn('⚠️ Webhook secret not set. Skipping signature verification.');
        }
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const customerEmail = session.customer_details?.email;

        console.log(`✅ Pagamento confirmado para o usuário: ${userId} (${customerEmail})`);

        // Upgrade user in Supabase
        if (userId) {
            try {
                const { data, error } = await supabaseAdmin
                    .from('profiles')
                    .upsert({
                        id: userId,
                        email: customerEmail,
                        plan: 'premium',
                        credits: 9999, // Unlimited or high number
                        updated_at: new Date().toISOString()
                    });

                if (error) {
                    console.error('Erro ao atualizar Supabase:', error);
                } else {
                    console.log('✅ Perfil atualizado para Premium no banco de dados.');
                }
            } catch (dbError) {
                console.error('Exceção ao atualizar Supabase:', dbError);
            }
        }
    }

    res.status(200).end();
});

// Middleware for regular routes
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files (handled by Vercel in production)
if (process.env.NODE_ENV !== 'production') {
    app.use(express.static(path.join(__dirname, '../public')));
}

// Health check route
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nutrik.AI Backend is running' });
});

// Stripe Checkout Session
app.post('/api/checkout-session', async (req, res) => {
    try {
        const { email, userId } = req.body;

        if (!email || !userId) {
            return res.status(400).json({ error: 'Email and UserId are required' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email, // Pre-fill the user's email
            client_reference_id: userId, // Pass the Supabase user ID back via webhook
            line_items: [
                {
                    price_data: {
                        currency: 'brl',
                        product_data: {
                            name: 'Nutrik.IA Premium',
                            description: 'Acesso total, passes livres e análise de humor.',
                        },
                        unit_amount: 5700, // R$ 57.00
                        recurring: { interval: 'month' }
                    },
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            // Use the host header to determine the success/cancel URLs dynamically
            success_url: `${req.protocol}://${req.get('host')}/chat.html?success=true`,
            cancel_url: `${req.protocol}://${req.get('host')}/plans.html?canceled=true`,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Nutrik.IA Chat Endpoint (Gemini Integration)
app.post('/api/chat', async (req, res) => {
    console.log('[API CHAT] Recebendo requisição com Native SDK...');
    try {
        const { message, imageBase64, history } = req.body;

        if (!message && !imageBase64) {
            return res.status(400).json({ error: 'Mensagem ou imagem é obrigatória' });
        }

        // Initialize model (gemini-1.5-flash is extremely stable for vision)
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: `Você é o Nutrik.IA, um assistente nutricional parceiro de saúde do usuário. Responda de forma amigável e técnica.
            MUITO IMPORTANTE: Se o usuário enviar uma foto de comida, você DEVE listar as gramas estimadas de cada alimento e o total de Macronutrientes (Prot, Carb, Gord) e Calorias. Use <strong> para destacar valores.`
        });

        // Format history
        let contents = [];
        if (history && Array.isArray(history)) {
            contents = history.map(h => ({
                role: h.role === 'model' || h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.text }]
            }));
        }

        // Current user message parts
        let currentParts = [];

        // Add text instruction
        const promptText = message || "Analise esta refeição detalhadamente, dando gramas e macros.";
        currentParts.push({ text: promptText });

        // Add image if present
        if (imageBase64) {
            const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                currentParts.push({
                    inlineData: {
                        data: matches[2],
                        mimeType: matches[1]
                    }
                });
            }
        }

        const chat = model.startChat({
            history: contents,
            generationConfig: {
                maxOutputTokens: 1000,
                temperature: 0.4,
            },
        });

        const result = await chat.sendMessage(currentParts);
        const responseText = result.response.text();

        res.json({ reply: responseText });

    } catch (error) {
        console.error('Error in Native Gemini Chat:', error);

        if (error.message.includes('429') || error.message.toLowerCase().includes('limit')) {
            return res.status(429).json({
                error: 'Opa! O cérebro da IA está respirando no momento (limite de uso grátis atingido). Por favor, espere uns 60 segundos e tente novamente! ⏳'
            });
        }

        res.status(500).json({
            error: 'Erro técnico ao conectar com a IA. Tente atualizar a página.',
            details: error.message
        });
    }
});

// Vercel handles static routing

// Start Server locally if not required as a module (Serverless)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
    });
}

module.exports = app;

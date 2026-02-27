require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');
const OpenAI = require('openai');

// Initialize OpenAI Client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy_openai_key' });

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
    app.use(express.static(path.join(__dirname)));
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
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment', // Change to 'subscription' later if recurring is needed
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
    console.log('[API CHAT] Recebendo requisição...');
    try {
        const { message, imageBase64, history } = req.body;
        console.log(`[API CHAT] Mensagem recebida: "${message}"`);
        console.log(`[API CHAT] Tem imagem? ${!!imageBase64}`);

        if (!message && !imageBase64) {
            console.log('[API CHAT] Erro: Sem mensagem ou imagem');
            return res.status(400).json({ error: 'Mensagem ou imagem é obrigatória' });
        }

        // Initialize multi-turn chat format
        let contentsArray = [];

        if (history && Array.isArray(history)) {
            history.forEach(h => {
                if (h.text) {
                    contentsArray.push({
                        role: h.role === 'model' ? 'model' : 'user',
                        parts: [{ text: h.text }]
                    });
                }
            });
        }

        let currentParts = [];

        // If there is an image, attach it to the prompt
        if (imageBase64) {
            try {
                const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);

                if (matches && matches.length === 3) {
                    const mimeType = matches[1];
                    let rawBase64 = matches[2];
                    const cleanBase64 = Buffer.from(rawBase64, 'base64').toString('base64');

                    currentParts.push({
                        inlineData: {
                            data: cleanBase64,
                            mimeType: mimeType
                        }
                    });
                } else {
                    return res.status(400).json({ error: 'Formato de imagem inválido' });
                }
            } catch (e) {
                return res.status(400).json({ error: 'Falha ao decodificar a imagem' });
            }
        }

        // Add user message
        currentParts.push({ text: message || "Analise a imagem desta refeição e me dê uma estimativa dos macronutrientes." });

        contentsArray.push({ role: 'user', parts: currentParts });

        console.log("[GEMINI SDK PAYLOAD]:", JSON.stringify(contentsArray, null, 2));

        // System prompt context for the AI persona
        const systemPrompt = `Você é o Nutrik.IA, um assistente nutricional parceiro de saúde parceiro do usuário.
        Responda de forma ESTRITAMENTE amigável, ágil, assertiva e motivadora. 
        MUITO IMPORTANTE: Se o usuário fornecer na conversa dados corporais (ex: peso, altura, idade e objetivo), você DEVE CLARAMENTE CALCULAR a Taxa Metabólica Basal (TMB/BMR) dele usando a fórmula de Harris-Benedict ou Mifflin-St Jeor e informar a ele a faixa calórica diária ideal. Não jogue a pergunta de volta, assuma o papel de calculadora se ele deu os dados.
        MUITO IMPORTANTE: Se o usuário enviar uma foto de comida, estime as calorias e macronutrientes (Proteína, Carbo, Gordura) da melhor forma possível com os dados visuais, listando-os e alertando que é uma estimativa visual. 
        Formate a resposta usando HTML básico se quiser destacar macros (ex: <strong>30g Proteína</strong>), mas mantenha o fluxo do texto limpo.
        Não use markdown markdown complexo no meio do texto, prefira responder imitando uma conversa de WhatsApp humanizada.`;

        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash-latest',
            contents: contentsArray,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.7
            }
        });

        res.json({ reply: response.text });

    } catch (error) {
        console.error('Error in Gemini Chat:', error);
        res.status(500).json({
            error: 'Erro ao processar sua solicitação com a inteligência artificial',
            details: error.message,
            stack: error.stack
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

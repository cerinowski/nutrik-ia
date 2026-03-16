require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key');

// Initialize Google Generative AI
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const supabaseUrl = process.env.SUPABASE_URL || 'https://aoejmzgcgvvtyokfvubn.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || 'dummy_key';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// Webhook da Stripe precisa do body original sem parse pra checar a assinatura
app.post(['/api/webhook', '/webhook/stripe'], express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('⚠️  Erro no Webhook da Stripe:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.userId || session.client_reference_id;
        const email = session.customer_email || session.customer_details?.email;

        console.log(`[STRIPE WEBHOOK] Checkout Session Completed. UserId: ${userId}, Email: ${email}`);

        if (userId || email) {
            const updateData = { plan: 'premium', credits: 99999 };

            if (session.subscription) {
                try {
                    const subscription = await stripe.subscriptions.retrieve(session.subscription);
                    if (subscription && subscription.trial_end) {
                        updateData.trial_ends_at = new Date(subscription.trial_end * 1000).toISOString();
                    }
                } catch (err) {
                    console.error("Erro ao buscar detalhes da subscription:", err.message);
                }
            }

            let updateQuery = supabaseAdmin.from('profiles').update(updateData);
            if (userId) {
                updateQuery = updateQuery.eq('id', userId);
            } else {
                updateQuery = updateQuery.eq('email', email);
            }

            const { error } = await updateQuery;
            if (error) {
                console.error("Erro ao atualizar no Supabase:", error.message);
            } else {
                console.log("✅ Plano ativado com sucesso!");
            }
        }
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
        const subscription = event.data.object;
        if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
            const customer = await stripe.customers.retrieve(subscription.customer);
            const email = customer.email;
            if (email) {
                await supabaseAdmin.from('profiles').update({ plan: 'free', credits: 50 }).eq('email', email);
                console.log(`📉 Assinatura cancelada para: ${email}`);
            }
        }
    }

    res.json({ received: true });
});

// Middleware padrao para o resto das rotas
app.use(express.json({ limit: '50mb' }));

app.post('/api/checkout-session', async (req, res) => {
    try {
        const { email, userId, offer, trial } = req.body;

        if (!userId) {
            return res.status(400).json({ error: "userId obrigatório." });
        }

        // Busca o perfil atual para ver se tem referred_by
        let stripeAccountIdToTransfer = null;
        try {
            const { data: profile } = await supabaseAdmin.from('profiles').select('referred_by').eq('id', userId).single();
            if (profile && profile.referred_by) {
                // Busca o perfil do afiliado
                const { data: affiliate } = await supabaseAdmin.from('profiles').select('stripe_account_id').eq('affiliate_code', profile.referred_by).single();
                if (affiliate && affiliate.stripe_account_id) {
                    stripeAccountIdToTransfer = affiliate.stripe_account_id;
                    console.log(`[AFILIADOS] Compra detectada com ref ${profile.referred_by}. Comissão irá para ${stripeAccountIdToTransfer}`);
                }
            }
        } catch (e) {
            console.error("Erro ao verificar afiliado no checkout:", e);
        }

        const origin = req.headers.origin || 'https://nutrik-ia.vercel.app'; // Fallback ajeitado caso origin venha vazio

        let discounts = [];
        if (offer === 'OFERTA30') {
            try {
                // Busca o ID do código promocional ativo na Stripe pelo nome
                const promoCodes = await stripe.promotionCodes.list({ code: 'OFERTA30', active: true, limit: 1 });
                if (promoCodes.data.length > 0) {
                    discounts = [{ promotion_code: promoCodes.data[0].id }];
                }
            } catch (err) {
                console.error("Erro ao buscar promo code:", err);
            }
        }

        const sessionConfig = {
            payment_method_types: ['card'],
            customer_email: email,
            client_reference_id: userId,
            line_items: [
                {
                    price: 'price_1TBj7cFobyRkpryqf7ZbW0MX', // O ID do Produto na Stripe
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${origin}/dashboard.html?premium=success`,
            cancel_url: `${origin}/plans.html?canceled=true`,
            metadata: {
                userId: userId
            }
        };

        // Configuração de Trial (Teste Grátis)
        if (trial) {
            if (!sessionConfig.subscription_data) sessionConfig.subscription_data = {};
            sessionConfig.subscription_data.trial_period_days = 3;
            console.log(`[STRIPE] Criando checkout com TRIAL de 3 dias para ${userId}`);
        }

        if (stripeAccountIdToTransfer) {
            try {
                // Stripe proibe criar checkout com destination para contas restritas.
                // Precisamos garantir que eles conseguem receber (transfers_enabled).
                const account = await stripe.accounts.retrieve(stripeAccountIdToTransfer);
                if (account && account.transfers_enabled && account.charges_enabled) {
                    // Repassa 30% da assinatura para o afiliado (automático)
                    if (!sessionConfig.subscription_data) sessionConfig.subscription_data = {};
                    sessionConfig.subscription_data.transfer_data = {
                        destination: stripeAccountIdToTransfer,
                        amount_percent: 30.0,
                    };
                } else {
                    console.warn(`[AFILIADOS] A conta Stripe ${stripeAccountIdToTransfer} está restrita/incompleta. Comissão será ignorada.`);
                }
            } catch (err) {
                console.error("Erro ao verificar conta do afiliado:", err);
            }
        }

        if (discounts.length > 0) {
            sessionConfig.discounts = discounts;
        } else {
            sessionConfig.allow_promotion_codes = true;
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        res.json({ url: session.url });
    } catch (error) {
        console.error("Erro ao criar Stripe Session:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint do Portal do Cliente (Para Cancelar/Alterar Assinatura)
app.post('/api/create-portal-session', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email obrigatório." });

        // Encontrar o cliente na Stripe pelo email
        const customers = await stripe.customers.search({
            query: `email:'${email}'`,
            limit: 1
        });

        if (!customers.data || customers.data.length === 0) {
            return res.status(404).json({ error: "Cliente não encontrado na Stripe." });
        }

        const customerId = customers.data[0].id;
        const origin = req.headers.origin || 'https://nutrik-ia.vercel.app';

        // Criar a sessão do Portal
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${origin}/dashboard.html`,
        });

        res.json({ url: portalSession.url });
    } catch (error) {
        console.error("Erro ao criar Stripe Portal Session:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- SISTEMA DE AFILIADOS ---

app.post('/api/affiliate/generate', async (req, res) => {
    try {
        const { userId, email } = req.body;
        if (!userId) return res.status(400).json({ error: "userId obrigatório." });

        const baseStr = (email ? email.split('@')[0] : 'user').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const code = `${baseStr}${randomNum}`;

        const { error } = await supabaseAdmin.from('profiles').update({ affiliate_code: code }).eq('id', userId);
        if (error) throw error;

        res.json({ code });
    } catch (err) {
        console.error("Erro ao gerar afiliado:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/affiliate/onboard', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId obrigatório." });

        const origin = req.headers.origin || 'https://nutrik-ia.vercel.app';

        let { data: profile } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).single();
        if (!profile) return res.status(404).json({ error: "Perfil não encontrado." });

        let accountId = profile.stripe_account_id;

        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                email: profile.email,
                capabilities: {
                    transfers: { requested: true },
                    card_payments: { requested: true }
                },
                business_type: 'individual',
            });
            accountId = account.id;
            await supabaseAdmin.from('profiles').update({ stripe_account_id: accountId }).eq('id', userId);
        }

        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${origin}/affiliate.html`,
            return_url: `${origin}/affiliate.html`,
            type: 'account_onboarding',
        });

        res.json({ url: accountLink.url });
    } catch (err) {
        console.error("Erro no Stripe Onboard:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/affiliate/dashboard', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "userId obrigatório." });

        let { data: profile } = await supabaseAdmin.from('profiles').select('stripe_account_id').eq('id', userId).single();
        if (!profile || !profile.stripe_account_id) return res.status(404).json({ error: "Conta não encontrada." });

        try {
            // Se a conta já estiver 100% OK, isso gera o link pro painel financeiro deles
            const loginLink = await stripe.accounts.createLoginLink(profile.stripe_account_id);
            res.json({ url: loginLink.url });
        } catch (e) {
            // Se der erro (ex: conta restrita aguardando doc), mandamos pro onboarding pra eles terminarem
            const origin = req.headers.origin || 'https://nutrik-ia.vercel.app';
            const accountLink = await stripe.accountLinks.create({
                account: profile.stripe_account_id,
                refresh_url: `${origin}/affiliate.html`,
                return_url: `${origin}/affiliate.html`,
                type: 'account_onboarding',
            });
            res.json({ url: accountLink.url });
        }
    } catch (err) {
        console.error("Erro no Stripe Dashboard:", err);
        res.status(500).json({ error: err.message });
    }
});

// Middleware para validar chave de API
const validateApiKey = (req, res, next) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: "GEMINI_API_KEY não configurada no servidor." });
    }
    next();
};

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ✅ REQUISITO 2: Debug Bruto (Raw Text) para diagnosticar permissões
app.get('/api/debug-list-models', async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY ausente" });

        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': GEMINI_API_KEY }
        });

        const text = await r.text(); // <- text, pra não quebrar se não for JSON
        res.status(r.status).send(text);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint antigo (mantido para compatibilidade interna)
app.get('/api/debug-gemini-models', async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY ausente" });
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': GEMINI_API_KEY }
        });
        const data = await r.json();
        res.status(r.ok ? 200 : r.status).json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ✅ CHAT COM CASCATA (v1beta por padrão)
app.post('/api/chat', validateApiKey, async (req, res) => {
    try {
        const { message, imageBase64, history, profile } = req.body;
        if (!message && !imageBase64) return res.status(400).json({ error: 'Mensagem ou imagem obrigatória' });

        const userId = req.body.userId || req.headers['x-user-id'];
        let liveProfile = profile || {};
        let consumedToday = 0;
        let remainingToday = 0;

        // Fetch fresh profile data directly from Supabase to guarantee we have the latest weight/goal
        if (userId) {
            try {
                const { data: dbProfile, error } = await supabaseAdmin
                    .from('profiles')
                    .select('*')
                    .eq('id', userId)
                    .single();

                if (dbProfile && !error) {
                    liveProfile = { ...liveProfile, ...dbProfile };
                }

                // Buscar refeições de hoje no fuso horário do Brasil (America/Sao_Paulo)
                const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
                const brDateStr = formatter.format(new Date()); // Formato YYYY-MM-DD no Brasil
                const startOfDay = new Date(`${brDateStr}T00:00:00-03:00`).toISOString();

                const { data: mealsData, error: mealsError } = await supabaseAdmin
                    .from('meals')
                    .select('calories')
                    .eq('user_id', userId)
                    .gte('created_at', startOfDay);

                if (mealsData && !mealsError) {
                    consumedToday = mealsData.reduce((acc, m) => acc + (m.calories || 0), 0);
                }

            } catch (err) {
                console.warn("[LIVE PROFILE] Erro ao buscar perfil atualizado:", err.message);
            }
        }

        let profileContext = "";
        if (liveProfile && Object.keys(liveProfile).length > 0) {
            let tmb = 0;
            let dailyGoal = 0;

            // Recalculate TMB (Mifflin-St Jeor Equation)
            const weight = parseFloat(liveProfile.current_weight) || 0;
            const height = parseFloat(liveProfile.height) || 0;
            const age = parseInt(liveProfile.age) || 0;
            const gender = liveProfile.gender === 'female' ? 'F' : 'M';

            if (weight > 0 && height > 0 && age > 0) {
                if (gender === 'M') {
                    tmb = (10 * weight) + (6.25 * height) - (5 * age) + 5;
                } else {
                    tmb = (10 * weight) + (6.25 * height) - (5 * age) - 161;
                }

                // Add Activity Factor
                const multipliers = {
                    'sedentary': 1.2,
                    'light': 1.375,
                    'moderate': 1.55,
                    'active': 1.725,
                    'very_active': 1.9
                };
                const activityLevel = liveProfile.activity_level || 'light';
                tmb = Math.round(tmb * (multipliers[activityLevel] || 1.375));

                // Calculate Daily Goal based on Objective
                const goal = liveProfile.goal || 'maintain';
                if (goal === 'lose') dailyGoal = tmb - 500;
                else if (goal === 'gain') dailyGoal = tmb + 500;
                else dailyGoal = tmb;
            }

            let translatedGoal = 'Manter Peso';
            if (liveProfile.goal === 'lose') translatedGoal = 'Emagrecer';
            if (liveProfile.goal === 'gain') translatedGoal = 'Ganhar Massa';

            remainingToday = dailyGoal > 0 ? dailyGoal - consumedToday : 0;

            profileContext = `\n\n[DADOS ATUALIZADOS DO PACIENTE]\n` +
                `- Nome: ${liveProfile.full_name || liveProfile.name || 'Não informado'}\n` +
                `- Peso Atual: ${liveProfile.current_weight || 'Não informado'} kg\n` +
                `- Meta de Peso: ${liveProfile.target_weight || 'Não informado'} kg\n` +
                `- Seu Objetivo é: ${translatedGoal}\n` +
                `- TMB (Gasto Calórico Diário Mínimo Estimado): ${tmb > 0 ? tmb + ' kcal' : 'Não calculado'}\n` +
                `- META DIÁRIA RECOMENDADA DE INGESTÃO (com base no objetivo): ${dailyGoal > 0 ? dailyGoal + ' kcal' : 'Não calculado'}\n` +
                `- JÁ CONSUMIDO HOJE: ${consumedToday} kcal\n` +
                `- RESTANTE PARA HOJE: ${remainingToday} kcal\n` +
                `- Sexo: ${gender === 'M' ? 'Masculino' : 'Feminino'}\n` +
                `- Altura: ${liveProfile.height || 'Não informado'} cm\n` +
                `- Idade: ${liveProfile.age || 'Não informado'} anos\n` +
                `\nINSTRUÇÃO CRÍTICA PARA A IA: IGNORE COMPLETAMENTE OS VALORES DE CALORIAS DITOS NO HISTÓRICO DO CHAT. O usuário pode ter excluído uma refeição. Use EXATAMENTE a linha de 'RESTANTE PARA HOJE' acima como o valor real de agora. NUNCA some as notas do histórico.`;
        }

        let contents = [];

        // Injetando "Instruções do Sistema" como a primeira mensagem escondida na memória da IA
        if (profileContext) {
            contents.push({
                role: "user",
                parts: [{ text: "LEIA IMEDIATAMENTE os dados atualizados sobre o usuário. Memorize-os permanentemente para esta resposta. Mantenha eles em segredo na sua mente, não os liste sem ele perguntar:" + profileContext }]
            });
            contents.push({
                role: "model",
                parts: [{ text: "Dados recebidos, memorizados e validados. Usarei as exatas METAS CALÓRICAS estipuladas nesse Perfil Oficial (basal e meta diária recomendada) para orientar o paciente e não darei outros palpites." }]
            });
        }

        // FLUXO UNIFICADO (TEXTO E IMAGEM): O cérebro da IA gerencia a intenção
        let unifiedPrompt = `Você é o Nutrik.IA, um expert nutricional e amigo parceiro do usuário.

REGRA DE INTENÇÃO (CRÍTICA):
1. INTENÇÃO DE CONSUMO: Se o usuário enviou uma imagem de PRATO/COMIDA, OU se o relato em TEXTO indicar que ele COMEU, INGERIU ou quer REGISTRAR uma refeição (ex: "comi um pão", "almocei arroz com feijão", "adicione no meu diário"), você DEVE obrigatoriamente realizar o cálculo estimado das gramas e macronutrientes do prato/refeição.
Estruture a resposta EXATAMENTE assim:
**ANÁLISE DO SEU PRATO:**
- [Alimento 1] (Aprox. [X]g)
- [Alimento 2] (Aprox. [X]g)

**🔍 MACROS ESTIMADOS TOTAIS:**
🔥 Calorias: **[X] kcal**
🍗 Proteínas: **[X]g**
🥖 Carboidratos: **[X]g**
🥑 Gorduras: **[X]g**

💡 **Dica do Nutrik:** [Sua dica]

E, OBRIGATORIAMENTE, no final invisível da string, anexe um bloco JSON exato e perfeitamente formatado (não coloque vírgula extra no fim):
\`\`\`json
{"calories": 0, "protein": 0, "carbs": 0, "fat": 0, "description": "legenda ou nome principal do alimento consumido"}
\`\`\`

2. INTENÇÃO DE DÚVIDA: Se o usuário APENAS fez uma pergunta genérica, pediu dicas ou perguntou calorias TÉCNICAS sobre algo que ELE NÃO COMEU (ex: "quantas calorias tem um snickers?", "o que comer no café?"), VOCÊ ESTÁ ESTRITAMENTE PROIBIDO de gerar o bloco JSON no final. Apenas converse amigavelmente, responda à dúvida e o incentive. Nunca gere JSON em dúvidas genéricas.`;

        contents.push(
            {
                role: "user",
                parts: [{ text: unifiedPrompt }]
            },
            {
                role: "model",
                parts: [{ text: "Entendido! Como Nutrik.IA, serei humano para discernir a intenção. Só gerarei o formato 'Análise do Prato' junto com os 'Macros Totais' e o bendito bloco secreto JSON se eu detectar que a pessoa EFETIVAMENTE comeu/ingeriu ou quer registrar essa refeição (via foto ou texto). Caso contrário, serei apenas um mentor tirando a dúvida sem gerar código de banco de dados." }]
            }
        );


        if (history && Array.isArray(history)) {
            let lastRole = null;
            history.slice(-6).forEach(h => {
                const role = (h.role === 'model' || h.role === 'assistant') ? 'model' : 'user';
                if (role !== lastRole) {
                    contents.push({ role, parts: [{ text: h.text || "..." }] });
                    lastRole = role;
                }
            });
            if (lastRole === 'user' && (message || imageBase64)) contents.pop();
        }

        let currentParts = [];
        let reminderMsg = `\n\n[ATENÇÃO IA: IGNORE o cálculo calórico do histórico passado. Agora mesmo, o Banco de Dados afirma que o consumido total de hoje caiu para exatos ${consumedToday} kcal (Restam ${remainingToday} kcal). Baseie-se apenas nisto.]`;

        if (message) {
            currentParts.push({ text: message + reminderMsg });
        } else {
            currentParts.push({ text: "Analise esta imagem." + reminderMsg });
        }

        if (imageBase64) {
            const hasDataUri = imageBase64.startsWith("data:");
            if (hasDataUri) {
                const matches = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
                if (matches?.[1] && matches?.[2]) {
                    currentParts.push({ inline_data: { mime_type: matches[1], data: matches[2] } });
                }
            } else {
                currentParts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
            }
            if (!message) {
                currentParts.unshift({ text: "Analise esta imagem nutricionalmente: alimentos, gramas estimadas e macronutrientes." });
            }
        }

        contents.push({ role: "user", parts: currentParts });

        const payload = {
            contents,
            generationConfig: { maxOutputTokens: 8192, temperature: 0.2 }
        };

        // ✅ MEGA CASCATA ANTI-COTA PURIFICADA (Modelos extraídos Vivos via ListModels da API Key atual)
        // Ocultado do usuário: A Google extirpou todos os modelos legados "1.5" das novas chaves.
        // Array contendo EXCLUSIVAMENTE modelos que a Chave do Usuário atual enxerga.
        // Array contendo EXCLUSIVAMENTE modelos rápidos do Free Tier da Google (limitados a ~15 RPM).
        // Evitamos usar os modelos 'pro' pois a cota deles no Free Tier é de apenas 2 RPM e bloqueia imediatamente.
        const candidateModels = [
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-flash"
        ].filter(Boolean);

        let lastErr = null;
        let responseData = null;
        let response = null;

        for (const model of candidateModels) {
            const cleanModel = model.replace('models/', '');
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent`;

            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": GEMINI_API_KEY,
                    },
                    body: JSON.stringify(payload),
                });

                responseData = await response.json();

                if (response.ok) {
                    lastErr = null;
                    break; // Sucesso com esse modelo, para aqui e segue em frente
                }

                lastErr = responseData?.error?.message || `Erro no ${cleanModel} (${response.status})`;
                console.warn(`[ANTI-COTA] Modelo ${cleanModel} bloqueado ou falhou. Tentando o próximo modelo na fração de segundo...`, lastErr);

                // Em caso de erro 429 (Cota) ou 503, cai imediatamente para o próximo modelo sem Delay. 
                // Evita estourar os 10 segundos gratuitos da Vercel.

            } catch (err) {
                lastErr = err.message;
                console.warn(`[ANTI-COTA] Problema de fetch no ${cleanModel}:`, lastErr);
            }
        }

        if (lastErr) {
            console.error("Gemini Multi-Cascade Failed Integrally:", lastErr, responseData);
            throw new Error(lastErr);
        }

        let reply = "Não consegui processar a análise.";
        if (responseData.candidates?.length && responseData.candidates[0].content?.parts) {
            const parts = responseData.candidates[0].content.parts;
            reply = parts.map(p => p.text || "").join("\n");
        }

        // ✅ Persistência de Dados (Robusta e Flexível)
        let rawJson = null;
        const jsonBlockMatch = reply.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

        if (jsonBlockMatch && jsonBlockMatch[1]) {
            rawJson = jsonBlockMatch[1].trim();
            reply = reply.replace(jsonBlockMatch[0], "").trim(); // Remove da mensagem mostrada
        } else {
            // Tenta encontrar um objeto JSON nu, caso a IA não use markdown
            const fallbackMatch = reply.match(/\{[\s\S]+\}/);
            if (fallbackMatch) {
                rawJson = fallbackMatch[0].trim();
                reply = reply.replace(fallbackMatch[0], "").trim();
            }
        }

        let nutritionData = null;
        if (rawJson) {
            try {
                const parsed = JSON.parse(rawJson);

                // Normalizar chaves para minúsculo e suportar PT/EN
                nutritionData = {};
                for (let key in parsed) {
                    nutritionData[key.toLowerCase()] = parsed[key];
                }

                const userId = req.body.userId || req.headers['x-user-id'];
                console.log(`[MEAL LOG] Usuário: ${userId}, Dados Extraídos:`, nutritionData);

                if (userId && (nutritionData.calories || nutritionData.calorias || nutritionData.kcal) > 0) {
                    const safeRound = (val) => {
                        if (!val) return 0;
                        const num = parseFloat(String(val).replace(',', '.')); // Lida com vírgulas BR
                        return isNaN(num) ? 0 : Math.round(num);
                    };

                    const calories = safeRound(nutritionData.calories || nutritionData.calorias || nutritionData.kcal);
                    const protein = safeRound(nutritionData.protein || nutritionData.proteina);
                    const carbs = safeRound(nutritionData.carbs || nutritionData.carboidratos);
                    const fat = safeRound(nutritionData.fat || nutritionData.gordura);
                    const finalDesc = nutritionData.description || nutritionData.descricao || message || "Refeição analisada";

                    console.log(`[DATABASE] Iniciando inserção ADMIN (Ignora RLS) para ${userId}: ${finalDesc} (${calories}kcal)`);

                    const { data: insertData, error: insertError } = await supabaseAdmin.from('meals').insert({
                        user_id: userId,
                        description: finalDesc,
                        calories,
                        protein,
                        carbs,
                        fat,
                        image_url: imageBase64 ? "base64_stored" : null
                    }).select();

                    if (insertError) {
                        console.error("[DATABASE ERROR] Falha ao inserir refeição admin:", insertError);
                        nutritionData._admin_saved = false;
                        nutritionData._admin_error = insertError;
                    } else {
                        console.log("[DATABASE SUCCESS] Refeição inserida com ADMIN ID:", insertData?.[0]?.id);
                        nutritionData._admin_saved = true;
                    }
                } else {
                    console.warn("[MEAL LOG] Ignorando salvamento: userId ausente ou calorias <= 0");
                }

            } catch (e) {
                console.error("Erro ao processar JSON de nutrição:", e);
            }
        }

        res.json({ reply, nutrition: nutritionData });

    } catch (error) {
        console.error('Critical Chat Error:', error);
        res.status(500).json({ error: 'Erro técnico de IA', details: error.message });
    }
});

if (require.main === module) {
    app.listen(port, () => console.log(`Server acting on port ${port}`));
}

module.exports = app;

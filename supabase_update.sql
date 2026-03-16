-- 1. Atualizar Tabela de Perfis (Profiles)
-- Adiciona campos biométricos e objetivos
ALTER TABLE IF EXISTS public.profiles 
ADD COLUMN IF NOT EXISTS full_name TEXT,
ADD COLUMN IF NOT EXISTS age INTEGER,
ADD COLUMN IF NOT EXISTS gender TEXT,
ADD COLUMN IF NOT EXISTS current_weight FLOAT,
ADD COLUMN IF NOT EXISTS target_weight FLOAT,
ADD COLUMN IF NOT EXISTS height INTEGER,
ADD COLUMN IF NOT EXISTS goal TEXT, -- 'lose', 'gain', 'maintain'
ADD COLUMN IF NOT EXISTS activity_level TEXT,
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP WITH TIME ZONE;

-- 2. Criar Tabela de Histórico de Peso
CREATE TABLE IF NOT EXISTS public.weight_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    weight FLOAT NOT NULL,
    measured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Criar Tabela de Diário de Refeições
CREATE TABLE IF NOT EXISTS public.meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    description TEXT NOT NULL,
    image_url TEXT,
    calories INTEGER DEFAULT 0,
    protein INTEGER DEFAULT 0,
    carbs INTEGER DEFAULT 0,
    fat INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Habilitar Row Level Security (RLS) para segurança
ALTER TABLE public.weight_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meals ENABLE ROW LEVEL SECURITY;

-- 5. Criar Políticas de Acesso (O usuário só vê os próprios dados)
-- Política para Histórico de Peso
CREATE POLICY "Users can manage their own weight history" 
ON public.weight_history FOR ALL 
USING (auth.uid() = user_id);

-- Política para Refeições
CREATE POLICY "Users can manage their own meals" 
ON public.meals FOR ALL 
USING (auth.uid() = user_id);

-- Index para performance
CREATE INDEX IF NOT EXISTS idx_weight_history_user_date ON public.weight_history(user_id, measured_at);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON public.meals(user_id, created_at);

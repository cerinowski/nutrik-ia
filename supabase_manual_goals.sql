-- SQL para Metas Manuais (Nutricionista)
-- Execute no Editor SQL do seu projeto no Supabase

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS manual_calories FLOAT,
ADD COLUMN IF NOT EXISTS manual_protein FLOAT,
ADD COLUMN IF NOT EXISTS manual_carbs FLOAT,
ADD COLUMN IF NOT EXISTS manual_fats FLOAT;

COMMENT ON COLUMN public.profiles.manual_calories IS 'Taxa metabólica manual definida por profissional';
COMMENT ON COLUMN public.profiles.manual_protein IS 'Meta diária de proteína manual em gramas';
COMMENT ON COLUMN public.profiles.manual_carbs IS 'Meta diária de carboidratos manual em gramas';
COMMENT ON COLUMN public.profiles.manual_fats IS 'Meta diária de gorduras manual em gramas';

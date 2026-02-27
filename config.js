import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://aoejmzgcgvvtyokfvubn.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_fa21s24ZyIlO73XxvT_BqA_FVVO0VdM';

export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Expose globally for legacy non-module script tags in chat.html and plans.html
window.supabaseClient = supabaseClient;

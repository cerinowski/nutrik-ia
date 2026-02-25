const SUPABASE_URL = 'https://aoejmzgcgvvtyokfvubn.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fa21s24ZyIlO73XxvT_BqA_FVVO0VdM';

// The Supabase script is loaded via CDN in the HTML files before this module
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Variáveis de ambiente VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY são obrigatórias.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Persist session in localStorage so the user stays logged in across restarts
    persistSession: true,
    autoRefreshToken: true,
    // We handle URL parsing ourselves in the deep-link event listener (Tauri)
    detectSessionInUrl: false,
    // Implicit flow is required for custom URL schemes (cafezin://) because
    // PKCE stores the code verifier in the WebView but the OAuth callback
    // arrives from an external browser that has no access to it.
    flowType: 'implicit',
  },
})

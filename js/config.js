// ---------------------------------------------------------------------------
//  SplittyWise configuration
//
//  Replace both values with your own from:
//    Supabase dashboard -> Project Settings -> API
//
//  The anon key is SAFE to commit. It only ever grants what your Row Level
//  Security policies allow, and every table in schema.sql has RLS enabled.
//  The key you must never put here is the `service_role` key — that one
//  bypasses RLS entirely.
// ---------------------------------------------------------------------------

window.SPLITTYWISE_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',
};

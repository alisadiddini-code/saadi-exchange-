import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://xwbtsshqhqnsgbqbreto.supabase.co";
const supabaseKey = "sb_publishable_L8Y0PhVsDN7doVfebq_ZaQ_x3HSeYoy";

export const supabase = createClient(supabaseUrl, supabaseKey);
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = "https://xwbtsshqhqnsbgqbreto.supabase.co"; // URL پروژه‌ات
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3YnRzc2hxaHFuc2dicWJyZXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODg1NTAsImV4cCI6MjA5MjU2NDU1MH0.VbLk2_MXgMMl3iWt9u4PVvmfQd-bYqe2xYCwAJm4-UI"; // publishable key

export const supabase = createClient(supabaseUrl, supabaseKey);
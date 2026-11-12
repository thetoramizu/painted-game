import { createClient } from '@supabase/supabase-js';
import { environment } from '../../environment';

export const supabase = createClient(environment.supabaseUrl, environment.supabaseAnonKey);

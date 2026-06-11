import {supabase} from './lib/supabase.js'
const ids=(await supabase.from('linkedin_accounts').select('id').in('label',['Wal','Josh'])).data.map(a=>a.id)
// thread_editor_not_found en las últimas 24h (post system-account fix)
const {count}=await supabase.from('extension_commands').select('id',{count:'exact',head:true}).in('account_id',ids).eq('action','send_followup').ilike('error','%thread_editor_not_found%').gt('created_at',new Date(Date.now()-24*3600e3).toISOString())
console.log('thread_editor_not_found últimas 24h (post system-account fix):', count, count===0?'→ YA RESUELTO ✅':'→ revisar')
process.exit(0)

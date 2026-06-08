import {supabase} from '../lib/supabase.js'
import {dispatchCommand} from '../lib/extension-dispatch.js'
import {writeFileSync} from 'fs'
const { data: account } = await supabase.from('linkedin_accounts').select('id').eq('label','Josh').maybeSingle()
const msg = 'Hola Carlos, espero que todo muy bien. Paso a saludarte y mantener el contacto. Si en algún momento quieres intercambiar ideas o platicar de lo que estás liderando, aquí estoy. Un saludo.'
const cmd = await dispatchCommand(account.id, 'send_followup', {
  is_stress_test: true, dryRun: false,
  threadUrl: 'https://www.linkedin.com/messaging/thread/2-NzIxYzZjYmEtMDYxYi00OWVkLWJjYjMtMTIzNmRjNzgzNzk5XzEwMA==/',
  profileUrl: 'https://www.linkedin.com/in/carloschavezdeicaza/',
  leadId: '3fff7710-770a-43cb-a868-0c15da810029', leadName: 'Carlos Chavez de Icaza',
  message: msg, step: 3,
}, { relatedLeadId: '3fff7710-770a-43cb-a868-0c15da810029', expiresInMinutes: 7 })
writeFileSync('/tmp/jfur.txt', cmd); console.log('CMD='+cmd)

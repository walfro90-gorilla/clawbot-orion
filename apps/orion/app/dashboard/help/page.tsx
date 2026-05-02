import Link from "next/link"

export default function HelpPage() {
  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-10">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-50">📖 Instructivo de uso</h1>
        <p className="text-gray-400 text-sm mt-1">
          Guía completa de Orion CRM — cómo funciona cada módulo y cómo operarlo.
        </p>
      </div>

      {/* Índice */}
      <nav className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Contenido</p>
        <ol className="space-y-1 text-sm text-blue-400">
          {[
            ["¿Qué es Orion?",              "#que-es"],
            ["El pipeline de leads",        "#pipeline"],
            ["Campañas",                    "#campanas"],
            ["Leads",                       "#leads"],
            ["Seguimientos (FU1 · FU2 · FU3)", "#followups"],
            ["Motor de conversación IA",    "#ia"],
            ["Cerebro IA — Playbook",       "#cerebro"],
            ["Cuentas LinkedIn",            "#cuentas"],
            ["Monitor y alertas",           "#monitor"],
            ["Actividad",                   "#actividad"],
            ["Dashboard y filtros",         "#dashboard"],
            ["Roles de usuario",            "#roles"],
          ].map(([label, href]) => (
            <li key={href}>
              <a href={href} className="hover:text-blue-300 transition-colors">
                {label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* 1. Qué es Orion */}
      <Section id="que-es" title="1. ¿Qué es Orion?" icon="⚡">
        <p>
          Orion es el panel de control del sistema <strong>ClawBot</strong> — automatización de prospección B2B en
          LinkedIn. El sistema opera de forma autónoma: busca perfiles, envía invitaciones personalizadas, hace
          seguimientos y gestiona conversaciones con IA, todo dentro de límites diseñados para parecer actividad humana.
        </p>
        <p className="mt-3">
          <strong>Orion no toca LinkedIn directamente</strong> — eso lo hace <em>Prometheus</em>, el motor que corre en
          el servidor. Orion es donde configuras campañas, revisas resultados, apruebas mensajes y ves qué está pasando.
        </p>
        <Callout type="info">
          El sistema corre <strong>lunes a viernes, 9 AM – 7 PM (hora México)</strong>, con intervalos aleatorios entre
          acciones para simular comportamiento humano. Fuera de ese horario no envía nada.
        </Callout>
      </Section>

      {/* 2. Pipeline */}
      <Section id="pipeline" title="2. El pipeline de leads" icon="📊">
        <p>Cada lead avanza por estos estados en orden:</p>
        <div className="mt-4 space-y-2">
          {[
            ["⏳", "En cola (pending/scraped)", "Lead encontrado por el buscador, esperando que el sistema envíe la invitación."],
            ["✉️", "Invitado (invite_sent)", "Se envió la invitación de conexión con mensaje personalizado."],
            ["🤝", "Conectado (connected)", "Aceptó la invitación. Aún no ha respondido mensajes. Aquí inician los seguimientos."],
            ["📨", "FU1 (follow_up_sent)", "Se envió el primer seguimiento. Sigue sin responder."],
            ["📩", "FU2 (follow_up_sent_2)", "Se envió el segundo seguimiento."],
            ["💬", "Respondió (replied)", "El lead envió un mensaje. La IA toma el control de la conversación."],
            ["📅", "Reunión (meeting_booked)", "Se agendó una reunión por Cal.com."],
            ["💀", "Perdido (dead)", "No respondió después de todos los seguimientos. Se archiva automáticamente."],
            ["🚫", "Descalificado (disqualified)", "Gemini determinó que el perfil no califica para el producto."],
          ].map(([icon, label, desc]) => (
            <div key={label} className="flex gap-3 p-3 bg-gray-800/50 rounded-lg">
              <span className="text-lg shrink-0">{icon}</span>
              <div>
                <p className="text-sm font-medium text-gray-200">{label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
        <Callout type="info" className="mt-4">
          El pipeline se ve en el <Link href="/dashboard" className="text-blue-400">Dashboard</Link> como barras de
          progreso. Cada barra es clickeable y te lleva a los leads en ese estado.
        </Callout>
      </Section>

      {/* 3. Campañas */}
      <Section id="campanas" title="3. Campañas" icon="🎯">
        <p>
          Una campaña es la unidad de trabajo: define <em>a quién</em> buscar, <em>qué mensaje</em> enviar, y{" "}
          <em>cómo hacer seguimiento</em>. Cada campaña está ligada a una cuenta de LinkedIn.
        </p>

        <SubSection title="Crear una campaña">
          <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
            <li>Ve a <Link href="/dashboard/campaigns" className="text-blue-400">Campañas</Link> → <strong>Nueva campaña</strong>.</li>
            <li>Asigna una cuenta LinkedIn (asegúrate de que tenga cookie activa y proxy configurado).</li>
            <li>Configura los parámetros de búsqueda: palabras clave, ubicación, cantidad, lista blanca de títulos.</li>
            <li>Escribe el mensaje de invitación — o deja que Gemini lo genere (ver sección IA).</li>
            <li>Configura los seguimientos (FU1, FU2, FU3) y los delays entre ellos.</li>
            <li>Activa la campaña con el toggle <strong>Activa</strong>.</li>
          </ol>
        </SubSection>

        <SubSection title="Campos clave">
          <table className="w-full text-xs text-gray-300 mt-2">
            <thead><tr className="text-gray-500 border-b border-gray-700">
              <th className="text-left pb-2">Campo</th><th className="text-left pb-2">Para qué sirve</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {[
                ["Palabras clave (search_keywords)", "Términos para buscar perfiles en LinkedIn. Separados por coma."],
                ["Ubicación (search_location)", "Ciudad o región. Ej: 'Ciudad de México, Monterrey'"],
                ["Cantidad (search_count)", "Cuántos perfiles buscar por run (máx 50)."],
                ["Lista blanca de títulos", "Solo procesa leads cuyo título contenga alguna de estas palabras. Filtro de calidad."],
                ["Delay mínimo entre batches (min_batch_gap_min)", "Minutos mínimos entre dos runs de invitaciones. Default: 60 min."],
                ["follow_up_delay_days", "Días de silencio antes de enviar FU1. Default: 3 días."],
                ["Mensaje de invitación", "Texto del mensaje que acompaña la solicitud. Usa [Nombre] para personalizar."],
              ].map(([field, desc]) => (
                <tr key={field}>
                  <td className="py-2 pr-4 font-mono text-gray-400 align-top">{field}</td>
                  <td className="py-2 text-gray-300">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SubSection>

        <SubSection title="Duplicar una campaña">
          <p className="text-sm text-gray-300">
            En la lista de campañas hay un botón <strong>Duplicar</strong> en cada fila. Crea una copia exacta con
            todos los parámetros — útil para probar variantes de mensaje o asignar a otra cuenta LinkedIn.
          </p>
        </SubSection>

        <Callout type="warning">
          Una campaña <strong>no envía nada sola</strong> — el scheduler de Prometheus la lee cada 20-40 min y decide
          si corre cada job. Si la campaña está inactiva o la cuenta está baneada/pausada, se salta.
        </Callout>
      </Section>

      {/* 4. Leads */}
      <Section id="leads" title="4. Leads" icon="👥">
        <p>
          Los leads se crean de dos formas: el buscador los encuentra automáticamente en LinkedIn, o los importas
          manualmente vía CSV.
        </p>

        <SubSection title="Importar CSV">
          <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
            <li>Ve a <Link href="/dashboard/leads" className="text-blue-400">Leads</Link> → <strong>Importar CSV</strong>.</li>
            <li>El CSV debe tener columnas: <code className="bg-gray-800 px-1 rounded">full_name</code>,{" "}
              <code className="bg-gray-800 px-1 rounded">linkedin_url</code> (obligatorias). Opcionales:{" "}
              <code className="bg-gray-800 px-1 rounded">email</code>, <code className="bg-gray-800 px-1 rounded">company</code>.</li>
            <li>Selecciona la campaña destino y sube el archivo (máx 5 MB).</li>
            <li>Los leads aparecen en estado <em>pending</em> y el sistema los procesa en el siguiente batch.</li>
          </ol>
        </SubSection>

        <SubSection title="Acciones sobre leads">
          <div className="space-y-2 text-sm text-gray-300">
            <p>Desde la tabla de leads puedes:</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>Filtrar</strong> por estado, campaña, o buscar por nombre.</li>
              <li><strong>Ver detalle</strong> → perfil del lead, historial de eventos, notas.</li>
              <li><strong>Bulk actions</strong> → seleccionar varios y marcar como dead, descalificado, o resetear a pending.</li>
              <li><strong>Exportar</strong> → descarga CSV del filtro activo.</li>
            </ul>
          </div>
        </SubSection>
      </Section>

      {/* 5. Seguimientos */}
      <Section id="followups" title="5. Seguimientos (FU1 · FU2 · FU3)" icon="📨">
        <p>
          Los seguimientos se envían automáticamente a leads que <strong>conectaron pero no respondieron</strong>.
          No hay que hacer nada manualmente — el scheduler los detecta y los envía en horario laboral.
        </p>

        <SubSection title="¿Cuándo se activa cada uno?">
          <table className="w-full text-xs text-gray-300 mt-2">
            <thead><tr className="text-gray-500 border-b border-gray-700">
              <th className="text-left pb-2">Paso</th>
              <th className="text-left pb-2">Trigger</th>
              <th className="text-left pb-2">Config</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              <tr>
                <td className="py-2 pr-4 font-semibold text-purple-400">FU1</td>
                <td className="py-2 pr-4 text-gray-300">Status <em>connected</em> + silencio ≥ follow_up_delay_days</td>
                <td className="py-2 text-gray-400">Default: 3 días</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-semibold text-purple-400">FU2</td>
                <td className="py-2 pr-4 text-gray-300">Status <em>follow_up_sent</em> + silencio ≥ follow_up_step2_delay_days</td>
                <td className="py-2 text-gray-400">Default: 12 días</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-semibold text-purple-400">FU3 (Ghost job)</td>
                <td className="py-2 pr-4 text-gray-300">Status <em>follow_up_sent_2</em> + silencio ≥ follow_up_step3_delay_days</td>
                <td className="py-2 text-gray-400">Default: 21 días → luego se marca dead</td>
              </tr>
            </tbody>
          </table>
        </SubSection>

        <SubSection title="Caps anti-ban">
          <ul className="list-disc list-inside space-y-1 text-sm text-gray-300 ml-2">
            <li><strong>Máx 4 seguimientos por run</strong> — no envía más de 4 en una sola ejecución.</li>
            <li><strong>Máx 5 seguimientos por día</strong> — cap global entre FU1 + FU2 + FU3.</li>
            <li><strong>Delay entre mensajes</strong>: 45 – 120 segundos real entre cada lead.</li>
          </ul>
        </SubSection>

        <Callout type="info">
          Si la campaña tiene <strong>auto_reply_mode = auto o semi_auto</strong>, los mensajes de seguimiento los{" "}
          <strong>genera Gemini</strong> en tiempo real usando el perfil del lead. Si está en <em>manual</em>, usa
          el template estático que escribiste en la campaña.
        </Callout>
      </Section>

      {/* 6. Motor de conversación IA */}
      <Section id="ia" title="6. Motor de conversación IA" icon="🤖">
        <p>
          Cuando un lead responde, la IA toma el control y genera replies adaptativos hasta lograr agendar una reunión
          por Cal.com. La estrategia varía por turno:
        </p>

        <div className="mt-4 space-y-2">
          {[
            ["Turno 0", "Rapport", "Responde al primer mensaje. Pregunta abierta. No menciona ORION ni Cal.com."],
            ["Turno 1-2", "Profundizar", "Muestra valor sutilmente. Puede mencionar Cal.com si hay interés claro."],
            ["Turno 3+", "Cierre", "Ofrece sesión de 20 min directamente con el link de Cal.com."],
          ].map(([turn, label, desc]) => (
            <div key={turn} className="flex gap-3 p-3 bg-gray-800/50 rounded-lg">
              <div className="text-center shrink-0 w-16">
                <span className="text-xs font-bold text-blue-400">{turn}</span>
                <p className="text-[10px] text-gray-500">{label}</p>
              </div>
              <p className="text-sm text-gray-300 self-center">{desc}</p>
            </div>
          ))}
        </div>

        <SubSection title="Modos de operación">
          <table className="w-full text-xs text-gray-300 mt-2">
            <thead><tr className="text-gray-500 border-b border-gray-700">
              <th className="text-left pb-2">Modo</th><th className="text-left pb-2">Comportamiento</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-800">
              {[
                ["manual", "Gemini genera el borrador pero espera aprobación humana. Aparece en Mensajes → ApproveDraftBtn."],
                ["semi_auto", "Gemini genera y programa el envío con countdown. Puedes ver el mensaje antes y usar [Enviar ahora] o [Cancelar]."],
                ["auto", "Gemini genera y envía automáticamente tras el delay configurado. Sin fricción."],
              ].map(([mode, desc]) => (
                <tr key={mode}>
                  <td className="py-2 pr-4 font-mono font-semibold text-purple-400 align-top">{mode}</td>
                  <td className="py-2 text-gray-300">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SubSection>

        <SubSection title="Configuración IA en la campaña">
          <ul className="list-disc list-inside space-y-1 text-sm text-gray-300 ml-2">
            <li><strong>Tono</strong>: casual / professional / executive / technical.</li>
            <li><strong>Persona del emisor</strong>: describe quién &quot;habla&quot; — nombre, cargo, estilo. Gemini lo adopta.</li>
            <li><strong>Contexto de empresa</strong>: reemplaza el contexto EBOOMS default. Úsalo si tienes un pitch diferente.</li>
            <li><strong>Ejemplos de mensajes</strong>: pega mensajes que hayan funcionado. Gemini replica el tono y longitud.</li>
            <li><strong>Delay mín/máx</strong>: minutos de espera antes del envío automático (modo semi_auto/auto).</li>
          </ul>
        </SubSection>

        <SubSection title="Ver y gestionar conversaciones">
          <p className="text-sm text-gray-300">
            Ve a <Link href="/dashboard/conversations" className="text-blue-400">Mensajes</Link>. Cada fila muestra el
            lead, el turno actual de la IA, y el estado del draft:
          </p>
          <ul className="list-disc list-inside space-y-1 text-sm text-gray-300 ml-2 mt-2">
            <li><strong>Countdown amarillo</strong>: envío programado — puedes enviarlo antes o cancelarlo.</li>
            <li><strong>Botón verde &quot;Aprobar&quot;</strong>: modo manual — revisar y enviar.</li>
            <li>Haz clic en el nombre para ver el hilo completo de la conversación.</li>
          </ul>
        </SubSection>

        <Callout type="warning">
          La IA <strong>solo habla de lo que está en el perfil del lead</strong>. No inventa logros, expansiones ni
          estadísticas. Si el perfil tiene pocos datos, hace preguntas abiertas sobre el rol.
        </Callout>
      </Section>

      {/* 7. Cerebro IA */}
      <Section id="cerebro" title="7. Cerebro IA — Playbook" icon="🧠">
        <p>
          El Cerebro es el repositorio de ejemplos que Gemini usa como referencia al generar mensajes. A diferencia del
          campo &quot;Ejemplos de mensajes&quot; por campaña, el Playbook es <strong>global</strong> — aplica a todas las campañas.
        </p>

        <SubSection title="¿Cómo funciona?">
          <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
            <li>Agregas un ejemplo al Playbook con <strong>tags</strong> (ej: &quot;CEO&quot;, &quot;manufactura&quot;) y el <strong>turno</strong> al que aplica.</li>
            <li>Cuando Gemini genera un mensaje para un lead, busca los ejemplos cuyos tags coincidan con el perfil del lead.</li>
            <li>Los ejemplos relevantes se inyectan en el prompt como referencia de tono y longitud.</li>
            <li>Gemini los usa para calibrarse — <em>no los copia</em>, se inspira en el estilo.</li>
          </ol>
        </SubSection>

        <SubSection title="Agregar un ejemplo">
          <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
            <li>Ve a <Link href="/dashboard/cerebro" className="text-blue-400">Cerebro IA</Link>.</li>
            <li>Clic en <strong>+ Nuevo ejemplo</strong>.</li>
            <li>Llena: Título (ej: &quot;CFO México - FU1 efectivo&quot;), Situación, Tags separados por coma, Turnos donde aplica, y el mensaje ejemplo.</li>
            <li>Guarda. Activo de inmediato.</li>
          </ol>
        </SubSection>

        <Callout type="info">
          El <strong>Outcome</strong> de cada ejemplo se puede actualizar manualmente cuando confirmas que un mensaje
          funcionó (generó respuesta o reunión). Los ejemplos con mejor outcome se priorizan automáticamente.
        </Callout>
      </Section>

      {/* 8. Cuentas LinkedIn */}
      <Section id="cuentas" title="8. Cuentas LinkedIn" icon="🔗">
        <p>
          Cada campaña usa una cuenta LinkedIn. La cuenta necesita dos cosas para funcionar:
          una <strong>cookie li_at</strong> vigente y una <strong>URL de proxy</strong>.
        </p>

        <SubSection title="Renovar la cookie li_at">
          <ol className="list-decimal list-inside space-y-1 text-sm text-gray-300">
            <li>Inicia sesión en LinkedIn en tu navegador.</li>
            <li>Abre las DevTools (F12) → Application → Cookies → <code className="bg-gray-800 px-1 rounded">www.linkedin.com</code>.</li>
            <li>Busca la cookie llamada <code className="bg-gray-800 px-1 rounded">li_at</code> y copia su valor.</li>
            <li>Ve a <Link href="/dashboard/accounts" className="text-blue-400">Cuentas LI</Link> → edita la cuenta → pega el valor → Guardar.</li>
          </ol>
          <Callout type="warning" className="mt-3">
            Renueva la cookie cada <strong>25-30 días</strong>. El dashboard muestra una barra de salud con días restantes.
            Si llega a 60 días sin renovar, el sistema se pausa automáticamente para esa cuenta.
          </Callout>
        </SubSection>

        <SubSection title="Proxy">
          <p className="text-sm text-gray-300">
            El proxy es obligatorio. Sin él, LinkedIn detecta la IP del servidor (datacenter) y bloquea la cuenta.
            Formato: <code className="bg-gray-800 px-1 rounded">http://usuario:password@host:puerto</code>
          </p>
        </SubSection>

        <SubSection title="Cal.com URL">
          <p className="text-sm text-gray-300">
            Agrega tu link de Cal.com en la cuenta. La IA lo incluye automáticamente en el Turno 3 de la conversación
            para invitar a la reunión de 20 min.
          </p>
        </SubSection>

        <SubSection title="Warmup">
          <p className="text-sm text-gray-300">
            Cada cuenta tiene un estado de calentamiento que limita cuántas invitaciones envía por día:
          </p>
          <ul className="list-disc list-inside space-y-1 text-sm text-gray-300 ml-2 mt-1">
            <li><strong>cold</strong>: 3 invitaciones/día — cuenta nueva o pausada mucho tiempo.</li>
            <li><strong>warming</strong>: 8 invitaciones/día.</li>
            <li><strong>warm</strong>: 15 invitaciones/día — operación normal.</li>
          </ul>
        </SubSection>
      </Section>

      {/* 9. Monitor */}
      <Section id="monitor" title="9. Monitor y alertas" icon="🖥️">
        <p>
          El <Link href="/dashboard/monitor" className="text-blue-400">Monitor</Link> muestra alertas activas y el log
          de jobs del scheduler. Es la primera parada cuando algo no funciona.
        </p>

        <SubSection title="Tipos de alerta">
          <div className="space-y-2 mt-2">
            {[
              ["🔴", "critical", "Captcha detectado / Cuenta baneada", "Acción inmediata. Pausa la cuenta y renueva la cookie o el proxy."],
              ["🟡", "warning",  "Cookie expirando / Rate limit",       "Planear renovación. El sistema sigue funcionando pero con riesgo."],
              ["🔵", "info",     "Error en automatización",             "Fallo puntual. Generalmente se recupera solo en el siguiente tick."],
            ].map(([icon, sev, label, action]) => (
              <div key={sev} className="flex gap-3 p-3 bg-gray-800/50 rounded-lg">
                <span className="text-lg shrink-0">{icon}</span>
                <div>
                  <p className="text-sm font-medium text-gray-200">{label}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{action}</p>
                </div>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title="Log de jobs">
          <p className="text-sm text-gray-300">
            Cada tick del scheduler registra qué hizo: búsqueda, batch de invitaciones, followups, inbox, auto-reply.
            Puedes ver duración, leads procesados, y errores. Útil para diagnosticar por qué no se enviaron mensajes
            en un período.
          </p>
        </SubSection>
      </Section>

      {/* 10. Actividad */}
      <Section id="actividad" title="10. Actividad" icon="📋">
        <p>
          La página de <Link href="/dashboard/activity" className="text-blue-400">Actividad</Link> muestra el historial
          de invitaciones enviadas por día, con detalle de cada lead.
        </p>
        <SubSection title="Colores semáforo">
          <div className="space-y-1 mt-2 text-sm">
            {[
              ["🟢 Verde", "Enviado exitosamente"],
              ["🟡 Amarillo", "Omitido — DRY_RUN activo (modo prueba, no envió)"],
              ["🔴 Rojo", "Cookie expirada — LinkedIn rechazó la sesión"],
              ["🔵 Azul", "Descalificado por Gemini"],
              ["⚪ Gris", "Error o resultado desconocido"],
            ].map(([color, desc]) => (
              <div key={color} className="flex gap-3">
                <span className="text-gray-300 w-36 shrink-0">{color}</span>
                <span className="text-gray-400">{desc}</span>
              </div>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* 11. Dashboard */}
      <Section id="dashboard" title="11. Dashboard y filtros de fecha" icon="⚡">
        <p>
          El <Link href="/dashboard" className="text-blue-400">Dashboard</Link> muestra KPIs globales y el pipeline.
          Usa los botones de filtro en la esquina superior derecha para ver datos por período:
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          {[
            ["Hoy", "Leads creados hoy, invitaciones de hoy, respuestas de hoy."],
            ["Ayer", "Mismo desglose para el día anterior."],
            ["7 días", "Última semana. Útil para ver tendencias semanales."],
            ["Personalizado", "Selecciona rango de fechas con los date pickers."],
          ].map(([btn, desc]) => (
            <div key={btn} className="bg-gray-800/60 rounded-lg p-3">
              <p className="text-xs font-semibold text-blue-400">{btn}</p>
              <p className="text-xs text-gray-400 mt-1">{desc}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-gray-400 mt-3">
          El <strong>pipeline</strong> siempre muestra el estado actual de todos los leads (no cambia con el filtro de
          fecha — es una foto del momento presente).
        </p>
      </Section>

      {/* 12. Roles */}
      <Section id="roles" title="12. Roles de usuario" icon="🛡️">
        <table className="w-full text-xs text-gray-300 mt-2">
          <thead><tr className="text-gray-500 border-b border-gray-700">
            <th className="text-left pb-2">Rol</th>
            <th className="text-left pb-2">Acceso</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-800">
            {[
              ["god_admin", "Acceso total. Puede gestionar usuarios, cuentas, campañas, cerebro y monitor."],
              ["admin",     "Igual que god_admin excepto gestión de usuarios."],
              ["user",      "Solo ve las campañas y leads de su cuenta LinkedIn asignada. Sin acceso a cuentas ni monitor."],
              ["viewer",    "Solo lectura. No puede aprobar drafts ni hacer acciones."],
            ].map(([role, desc]) => (
              <tr key={role}>
                <td className="py-2 pr-4 font-mono font-semibold text-purple-400 align-top">{role}</td>
                <td className="py-2 text-gray-300">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-gray-400 mt-3">
          Para gestionar usuarios ve a <Link href="/dashboard/users" className="text-blue-400">Usuarios</Link>{" "}
          (solo admins).
        </p>
      </Section>

      {/* Footer */}
      <div className="border-t border-gray-800 pt-6 text-xs text-gray-600 text-center">
        Orion CRM · ClawBot · Prometheus Engine · Última actualización: Abril 2026
      </div>
    </div>
  )
}

// ── Layout components ─────────────────────────────────────────────────────────

function Section({ id, title, icon, children }: {
  id: string; title: string; icon: string; children: React.ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xl">{icon}</span>
        <h2 className="text-lg font-bold text-gray-50">{title}</h2>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4 text-sm text-gray-300 leading-relaxed">
        {children}
      </div>
    </section>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{title}</p>
      {children}
    </div>
  )
}

function Callout({ type, children, className = "" }: {
  type: "info" | "warning"; children: React.ReactNode; className?: string
}) {
  const styles = {
    info:    "bg-blue-500/10 border-blue-500/30 text-blue-300",
    warning: "bg-yellow-500/10 border-yellow-500/30 text-yellow-300",
  }
  const icons = { info: "ℹ️", warning: "⚠️" }
  return (
    <div className={`flex gap-2 p-3 rounded-lg border text-xs leading-relaxed ${styles[type]} ${className}`}>
      <span className="shrink-0">{icons[type]}</span>
      <span>{children}</span>
    </div>
  )
}

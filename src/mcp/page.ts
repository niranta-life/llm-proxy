export function mcpAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>MCP catalog</title>
  <style>
    :root { color-scheme: light; font-family: "Iowan Old Style", Palatino, serif; }
    body { margin: 0; background: #f4f0e6; color: #1c1915; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 32px; margin: 0 0 8px; }
    p { line-height: 1.4; }
    form, section { background: #fffdf8; border: 1px solid #d9d0c1; padding: 16px; margin: 16px 0; }
    label { display: block; margin: 8px 0 4px; font-family: "Helvetica Neue", Helvetica, sans-serif; font-size: 13px; }
    input, select, button { font: 16px/1.3 "Helvetica Neue", Helvetica, sans-serif; }
    input, select { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #8a8175; background: white; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    button { padding: 8px 12px; background: #1c1915; color: #f4f0e6; border: 0; cursor: pointer; }
    button.secondary { background: #5c564c; }
    table { width: 100%; border-collapse: collapse; font-family: "Helvetica Neue", Helvetica, sans-serif; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #e4dccb; padding: 6px 4px; vertical-align: top; }
    #status { min-height: 1.4em; font-family: "Helvetica Neue", Helvetica, sans-serif; }
    code { font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
<main>
  <h1>MCP catalog</h1>
  <p>Register an approved server, test the connection, and discover tools. This page does not call a tool. An approved execution calls one approved tool.</p>
  <p id="status" role="status"></p>
  <form id="session-form">
    <label for="tenant-id">Tenant id</label>
    <input id="tenant-id" name="tenantId" autocomplete="off" required>
    <label for="api-key">API key</label>
    <input id="api-key" name="apiKey" type="password" autocomplete="off" required>
    <div class="row"><button type="submit">Use credential</button></div>
  </form>
  <form id="register-form">
    <label for="server-key">Server key</label>
    <input id="server-key" name="serverKey" required>
    <label for="display-name">Display name</label>
    <input id="display-name" name="displayName" required>
    <label for="endpoint">Endpoint</label>
    <input id="endpoint" name="endpoint" required>
    <label for="credential">Server credential</label>
    <input id="credential" name="credential" type="password" autocomplete="off" required>
    <label for="protocol-mode">Protocol</label>
    <select id="protocol-mode" name="protocolMode">
      <option value="modern">Modern 2026-07-28</option>
      <option value="legacy">Legacy compatibility</option>
    </select>
    <div class="row"><button type="submit">Register server</button></div>
  </form>
  <section>
    <h2>Servers</h2>
    <div class="row">
      <button type="button" id="refresh-servers" class="secondary">Refresh</button>
      <button type="button" id="test-connection">Test connection</button>
      <button type="button" id="discover">Discover tools</button>
      <button type="button" id="enable">Enable</button>
      <button type="button" id="disable" class="secondary">Disable</button>
      <button type="button" id="read-health" class="secondary">Read health</button>
    </div>
    <table>
      <thead><tr><th></th><th>Key</th><th>Status</th><th>Protocol</th><th>Enabled</th><th>Fingerprint</th><th>Cache age</th></tr></thead>
      <tbody id="server-rows"></tbody>
    </table>
    <pre id="health"></pre>
  </section>
  <section>
    <h2>Tools</h2>
    <label for="tool-effect">Effect</label>
    <select id="tool-effect" name="toolEffect">
      <option value="">Unspecified</option>
      <option value="read">Read</option>
      <option value="write">Write</option>
    </select>
    <div class="row">
      <button type="button" id="allow-tool">Allow tool</button>
      <button type="button" id="deny-tool" class="secondary">Deny tool</button>
      <button type="button" id="refresh-catalog" class="secondary">Refresh catalog</button>
    </div>
    <table>
      <thead><tr><th></th><th>Namespaced name</th><th>Allowed</th><th>Effect</th><th>Version</th></tr></thead>
      <tbody id="tool-rows"></tbody>
    </table>
    <h2>Exposed catalog</h2>
    <table>
      <thead><tr><th>Namespaced name</th><th>Protocol</th><th>Fingerprint</th><th>Cache age</th></tr></thead>
      <tbody id="catalog-rows"></tbody>
    </table>
  </section>
  <section>
    <h2>Exposed tools</h2>
    <p>These tools are available on /mcp for this tenant. A read tool is allowed. Inference and embedding stay off until you approve them.</p>
    <div class="row">
      <button type="button" id="approve-exposed">Approve tool</button>
      <button type="button" id="deny-exposed" class="secondary">Deny tool</button>
      <button type="button" id="refresh-exposed" class="secondary">Refresh exposed</button>
    </div>
    <table>
      <thead><tr><th></th><th>Tool</th><th>Kind</th><th>Permission</th></tr></thead>
      <tbody id="exposed-rows"></tbody>
    </table>
  </section>
  <section>
    <h2>Executions</h2>
    <p>A read runs after the checks. A write waits for approval. Denial and cancellation do not call the tool.</p>
    <label for="execution-request">Request id</label>
    <input id="execution-request" name="requestId" autocomplete="off">
    <label for="execution-call">Tool call id</label>
    <input id="execution-call" name="toolCallId" autocomplete="off">
    <label for="execution-arguments">Arguments</label>
    <input id="execution-arguments" name="arguments" autocomplete="off" value="{&quot;note&quot;:&quot;alpha&quot;}">
    <div class="row">
      <button type="button" id="run-tool">Run tool</button>
      <button type="button" id="approve-execution">Approve</button>
      <button type="button" id="deny-execution" class="secondary">Deny</button>
      <button type="button" id="cancel-execution" class="secondary">Cancel</button>
      <button type="button" id="refresh-executions" class="secondary">Refresh executions</button>
    </div>
    <table>
      <thead><tr><th></th><th>Tool</th><th>Permission</th><th>Approval</th><th>Status</th><th>Latency</th><th>Failure</th></tr></thead>
      <tbody id="execution-rows"></tbody>
    </table>
  </section>
</main>
<script>
  const status = document.querySelector('#status');
  let tenantId = '';
  let apiKey = '';
  let selectedServer = '';
  let selectedTool = '';
  let selectedExecution = '';
  let selectedExposed = '';
  let executionIdentity = '';
  let knownTools = [];

  function say(text) {
    status.textContent = text;
  }

  async function call(method, path, body) {
    const headers = { 'x-tenant-id': tenantId, authorization: 'Bearer ' + apiKey };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let payload = null;
    if (text.length > 0) payload = JSON.parse(text);
    if (!response.ok) {
      const message = payload && payload.error && payload.error.message ? payload.error.message : 'The request failed.';
      throw new Error(message);
    }
    return payload;
  }

  function selectedRadio(name) {
    const node = document.querySelector('input[name="' + name + '"]:checked');
    return node ? node.value : '';
  }

  function fillServers(servers) {
    const body = document.querySelector('#server-rows');
    body.replaceChildren();
    for (const server of servers) {
      const row = document.createElement('tr');
      const pick = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'server';
      input.value = server.id;
      input.addEventListener('change', () => { selectedServer = server.id; });
      if (server.id === selectedServer) input.checked = true;
      pick.append(input);
      row.append(pick);
      for (const value of [server.serverKey, server.connectionStatus, server.protocolVersion || server.protocolMode, String(server.enabled), server.catalogFingerprint || '', server.cacheAgeMs === null ? '' : String(server.cacheAgeMs)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }

  function fillTools(tools) {
    knownTools = tools;
    const body = document.querySelector('#tool-rows');
    body.replaceChildren();
    for (const tool of tools) {
      const row = document.createElement('tr');
      const pick = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tool';
      input.value = tool.remoteName;
      input.addEventListener('change', () => { selectedTool = tool.remoteName; });
      if (tool.remoteName === selectedTool) input.checked = true;
      pick.append(input);
      row.append(pick);
      for (const value of [tool.namespacedName, String(tool.allowed), tool.effect || '', String(tool.catalogVersion)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }

  function fillExecutions(executions) {
    const body = document.querySelector('#execution-rows');
    body.replaceChildren();
    for (const execution of executions) {
      const row = document.createElement('tr');
      const pick = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'execution';
      input.value = execution.id;
      input.addEventListener('change', () => { selectedExecution = execution.id; });
      if (execution.id === selectedExecution) input.checked = true;
      pick.append(input);
      row.append(pick);
      const latency = execution.latencyMs === null || execution.latencyMs === undefined ? '' : String(execution.latencyMs);
      for (const value of [execution.namespacedName, execution.permission, execution.approval, execution.status, latency, execution.errorMessage || '']) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }

  function fillCatalog(catalog) {
    const body = document.querySelector('#catalog-rows');
    body.replaceChildren();
    for (const tool of catalog) {
      const row = document.createElement('tr');
      for (const value of [tool.namespacedName, tool.protocolVersion || '', tool.fingerprint || '', tool.cacheAgeMs === null ? '' : String(tool.cacheAgeMs)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }

  async function refreshAll() {
    const listed = await call('GET', '/internal/v1/mcp/servers');
    fillServers(listed.servers);
    const catalog = await call('GET', '/internal/v1/mcp/catalog');
    fillCatalog(catalog.catalog);
    if (selectedServer) {
      const tools = await call('GET', '/internal/v1/mcp/servers/' + selectedServer + '/tools');
      fillTools(tools.tools);
    }
    const executions = await call('GET', '/internal/v1/mcp/executions');
    fillExecutions(executions.executions);
    await refreshExposed();
  }

  function fillExposed(tools) {
    const body = document.querySelector('#exposed-rows');
    body.replaceChildren();
    for (const tool of tools) {
      const row = document.createElement('tr');
      const pick = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'exposed';
      input.value = tool.name;
      input.addEventListener('change', () => { selectedExposed = tool.name; });
      if (tool.name === selectedExposed) input.checked = true;
      pick.append(input);
      row.append(pick);
      for (const value of [tool.name, tool.kind, tool.permission]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
  }

  async function refreshExposed() {
    const listed = await call('GET', '/internal/v1/mcp/exposed');
    fillExposed(listed.tools);
  }

  document.querySelector('#session-form').addEventListener('submit', (event) => {
    event.preventDefault();
    tenantId = document.querySelector('#tenant-id').value.trim();
    apiKey = document.querySelector('#api-key').value;
    say('Credential is ready for this page.');
  });

  document.querySelector('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const saved = await call('POST', '/internal/v1/mcp/servers', {
        serverKey: document.querySelector('#server-key').value.trim(),
        displayName: document.querySelector('#display-name').value.trim(),
        endpoint: document.querySelector('#endpoint').value.trim(),
        credential: document.querySelector('#credential').value,
        protocolMode: document.querySelector('#protocol-mode').value
      });
      selectedServer = saved.server.id;
      document.querySelector('#credential').value = '';
      await refreshAll();
      say('Server ' + saved.server.serverKey + ' is registered.');
    } catch (error) {
      say(error.message);
    }
  });

  document.querySelector('#refresh-servers').addEventListener('click', async () => {
    try { await refreshAll(); say('The list is current.'); } catch (error) { say(error.message); }
  });

  async function postServer(action) {
    selectedServer = selectedRadio('server') || selectedServer;
    if (!selectedServer) { say('Select a server.'); return null; }
    return call('POST', '/internal/v1/mcp/servers/' + selectedServer + '/' + action, action === 'enabled' ? undefined : {});
  }

  document.querySelector('#test-connection').addEventListener('click', async () => {
    try {
      const result = await call('POST', '/internal/v1/mcp/servers/' + (selectedRadio('server') || selectedServer) + '/test', {});
      await refreshAll();
      say('Connection is ' + result.server.connectionStatus + '. Protocol ' + result.server.protocolVersion + '.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#discover').addEventListener('click', async () => {
    try {
      const result = await call('POST', '/internal/v1/mcp/servers/' + (selectedRadio('server') || selectedServer) + '/discover', {});
      await refreshAll();
      say('Discovery stored version ' + result.catalogVersion + '. Changed ' + String(result.changed) + '.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#enable').addEventListener('click', async () => {
    try {
      await call('POST', '/internal/v1/mcp/servers/' + (selectedRadio('server') || selectedServer) + '/enabled', { enabled: true });
      await refreshAll();
      say('The server is enabled.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#disable').addEventListener('click', async () => {
    try {
      await call('POST', '/internal/v1/mcp/servers/' + (selectedRadio('server') || selectedServer) + '/enabled', { enabled: false });
      await refreshAll();
      say('The server is disabled.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#read-health').addEventListener('click', async () => {
    try {
      const health = await call('GET', '/internal/v1/mcp/servers/' + (selectedRadio('server') || selectedServer) + '/health');
      document.querySelector('#health').textContent = JSON.stringify(health, null, 2);
      say('Health is ' + health.connectionStatus + '.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#allow-tool').addEventListener('click', async () => {
    try {
      const remoteName = selectedRadio('tool') || selectedTool;
      const effect = document.querySelector('#tool-effect').value;
      const body = { serverId: selectedRadio('server') || selectedServer, remoteName, allowed: true };
      if (effect === 'read' || effect === 'write') body.effect = effect;
      await call('POST', '/internal/v1/mcp/permissions', body);
      await refreshAll();
      say('The tool is allowed.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#deny-tool').addEventListener('click', async () => {
    try {
      const remoteName = selectedRadio('tool') || selectedTool;
      await call('POST', '/internal/v1/mcp/permissions', { serverId: selectedRadio('server') || selectedServer, remoteName, allowed: false });
      await refreshAll();
      say('The tool is denied.');
    } catch (error) { say(error.message); }
  });

  document.querySelector('#refresh-catalog').addEventListener('click', async () => {
    try { await refreshAll(); say('The catalog is current.'); } catch (error) { say(error.message); }
  });

  document.querySelector('#run-tool').addEventListener('click', async () => {
    try {
      const remoteName = selectedRadio('tool') || selectedTool;
      const tool = knownTools.find((item) => item.remoteName === remoteName);
      if (!tool) { say('Select a tool.'); return; }
      let args = null;
      try { args = JSON.parse(document.querySelector('#execution-arguments').value); } catch { say('The arguments are invalid.'); return; }
      const payload = await call('POST', '/internal/v1/mcp/executions', {
        serverId: selectedRadio('server') || selectedServer,
        remoteName,
        schemaVersion: tool.catalogVersion,
        requestId: document.querySelector('#execution-request').value.trim(),
        toolCallId: document.querySelector('#execution-call').value.trim(),
        arguments: args
      });
      if (payload.executionIdentity) executionIdentity = payload.executionIdentity;
      selectedExecution = payload.execution.id;
      await refreshAll();
      say('Execution ' + payload.execution.status + '.');
    } catch (error) { say(error.message); }
  });

  async function decide(decision) {
    selectedExecution = selectedRadio('execution') || selectedExecution;
    if (!selectedExecution) { say('Select an execution.'); return; }
    if (!executionIdentity) { say('The execution identity is invalid.'); return; }
    const payload = await call('POST', '/internal/v1/mcp/executions/' + selectedExecution + '/approval', { decision, executionIdentity });
    selectedExecution = payload.execution.id;
    await refreshAll();
    say('Execution ' + payload.execution.status + '.');
  }

  document.querySelector('#approve-execution').addEventListener('click', async () => {
    try { await decide('grant'); } catch (error) { say(error.message); }
  });

  document.querySelector('#deny-execution').addEventListener('click', async () => {
    try { await decide('deny'); } catch (error) { say(error.message); }
  });

  document.querySelector('#cancel-execution').addEventListener('click', async () => {
    try { await decide('cancel'); } catch (error) { say(error.message); }
  });

  document.querySelector('#refresh-executions').addEventListener('click', async () => {
    try { await refreshAll(); say('The execution list is current.'); } catch (error) { say(error.message); }
  });

  async function setExposed(approved) {
    selectedExposed = selectedRadio('exposed') || selectedExposed;
    if (!selectedExposed) { say('Select a tool.'); return; }
    await call('POST', '/internal/v1/mcp/exposed', { name: selectedExposed, approved });
    await refreshExposed();
    say(approved ? 'The tool is allowed.' : 'The tool is denied.');
  }

  document.querySelector('#approve-exposed').addEventListener('click', async () => {
    try { await setExposed(true); } catch (error) { say(error.message); }
  });

  document.querySelector('#deny-exposed').addEventListener('click', async () => {
    try { await setExposed(false); } catch (error) { say(error.message); }
  });

  document.querySelector('#refresh-exposed').addEventListener('click', async () => {
    try { await refreshExposed(); say('The exposed list is current.'); } catch (error) { say(error.message); }
  });
</script>
</body>
</html>
`;
}

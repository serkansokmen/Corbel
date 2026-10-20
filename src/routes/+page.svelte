<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '$lib/Icon.svelte';
  import { samples, exampleQuestions } from '$lib/samples';
  import type { Document, Run, Health, ExportedRun } from '$lib/types';
  import { QUERY_MAX, DOCUMENTS_MAX, DOCUMENT_CHARS_MAX, CORPUS_CHARS_MAX, DOCUMENT_TITLE_MAX, checkDocuments, checkQuery } from '$lib/limits';

  const libraryLimits = `${DOCUMENTS_MAX} documents, ${DOCUMENT_CHARS_MAX.toLocaleString('en-US')} characters each, ${CORPUS_CHARS_MAX.toLocaleString('en-US')} characters total`;
  const documentCharsMax = DOCUMENT_CHARS_MAX.toLocaleString('en-US');
  // C0 controls other than tab, LF, CR, backspace and form feed mean binary. Each JSON-escapes to 6 bytes, so enough of them push a library that passes checkDocuments past BODY_MAX.
  const binaryControls = /[\u0000-\u0007\u000B\u000E-\u001F]/;

  let tab = $state('workbench');
  let documents = $state<Document[]>(structuredClone(samples));
  let runs = $state<Run[]>([]);
  let query = $state(exampleQuestions[0]);
  let threshold = $state(0.8);
  let topK = $state(4);
  let activeRun = $state<Run | null>(null);
  let selectedEvidence = $state(0);
  let busy = $state(false);
  let error = $state('');
  let storageNotice = $state('');
  let health = $state<Health>({ status: 'offline' });
  let addingDocument = $state(false);
  let documentTitle = $state('');
  let documentText = $state('');
  let previewDocument = $state<Document | null>(null);
  let fileInput = $state<HTMLInputElement>();
  let abort: AbortController | undefined;

  const accepted = $derived(activeRun?.evidence.filter((e) => e.probability >= threshold) ?? []);
  const inspected = $derived(activeRun?.evidence[selectedEvidence]);
  const reviewed = $derived(runs.filter((r) => r.review));
  const selectedCorrect = $derived(reviewed.filter((r) => r.review === 'correct').length);
  const meanLatency = $derived(runs.length ? Math.round(runs.reduce((n, r) => n + r.latencyMs, 0) / runs.length) : null);
  const currentTitle = $derived(tab === 'workbench' ? 'Q&A workbench' : tab === 'library' ? 'Document library' : tab === 'runs' ? 'Experiment log' : 'Inside the pipeline');

  function save() {
    try {
      localStorage.setItem('corbel-v1', JSON.stringify({ documents, runs }));
      storageNotice = '';
    } catch { storageNotice = 'Browser storage is full or unavailable. Export your runs before closing this page.'; }
  }

  async function refreshHealth() {
    try { health = await (await fetch('/api/health', { signal: AbortSignal.timeout(5000) })).json(); }
    catch { health = { status: 'offline', message: 'Could not reach the local application service.' }; }
  }

  onMount(() => {
    try {
      const saved = localStorage.getItem('corbel-v1');
      if (saved) {
        const data = JSON.parse(saved);
        // Same check as /api/query, so a stored library the server would reject never loads. An emptied library ([]) is a valid UI state.
        const reason = Array.isArray(data.documents) && !data.documents.length ? null : checkDocuments(data.documents);
        if (reason) storageNotice = `Saved documents were not loaded because they are outside the library limits (${libraryLimits}). The sample corpus is loaded instead and replaces them on the next save.`; else documents = data.documents;
        if (Array.isArray(data.runs)) runs = data.runs.filter((r: Run) => typeof r.query === 'string' && Array.isArray(r.evidence)).slice(0, 20);
      }
    } catch { storageNotice = 'Saved browser data could not be loaded. The sample corpus is available.'; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refreshHealth();
      if (!disposed) timer = setTimeout(poll, health.status === 'ready' ? 30_000 : 5000);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); abort?.abort(); };
  });

  async function ask() {
    if (busy || checkQuery(query) || !documents.length) return; // checkQuery also stops an over-long query that openRun set from a stored run
    error = '';
    busy = true;
    activeRun = null;
    abort = new AbortController();
    const timeout = setTimeout(() => abort?.abort(), 125_000);
    try {
      const response = await fetch('/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, documents, threshold, topK }), signal: abort.signal
      });
      let result;
      try { result = await response.json(); } catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; result = null; } // a reverse proxy's plain-text or HTML error page (e.g. a proxy 413 or 502)
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : response.status === 413 ? "The document library exceeds the server's request size limit (413). If it is under 1 MB, start the production server with BODY_SIZE_LIMIT=1M." : `The query failed (HTTP ${response.status}). Check that the Corbel server is running and retry.`);
      if (!result || !Array.isArray(result.evidence)) throw new Error('The Corbel server returned an unreadable response. Retry shortly.');
      activeRun = result;
      selectedEvidence = 0;
      runs = [result, ...runs].slice(0, 20);
      save();
    } catch (cause) {
      error = cause instanceof Error && cause.name === 'AbortError' ? 'The request timed out. The backend may still be finishing this run; retry shortly.' : cause instanceof Error ? cause.message : 'The query failed. Retry shortly.';
    } finally { clearTimeout(timeout); busy = false; }
  }

  function openRun(run: Run) {
    activeRun = run;
    query = run.query;
    threshold = run.threshold;
    topK = run.topK;
    selectedEvidence = 0;
    error = '';
    tab = 'workbench';
  }

  function review(value: 'correct' | 'incorrect') {
    if (!activeRun) return;
    activeRun = { ...activeRun, threshold, review: value };
    runs = runs.map((r) => r.id === activeRun?.id ? activeRun : r);
    save();
  }

  // Every exported run keeps its stored threshold (the one it was run or last reviewed at). A single-run export adds
  // what the screen showed: the live slider value and the evidence ids accepted at it.
  function exportRuns(single = false) {
    const exported: ExportedRun[] = single && activeRun ? [{ ...activeRun, viewedThreshold: threshold, acceptedIds: accepted.map((e) => e.id) }] : runs;
    const payload = { format: 'corbel-runs-v1', exportedAt: new Date().toISOString(), retrieval: 'BM25 over paragraph-aligned chunks (target 320 characters, max 600)', calibration: 'Not calibrated on this corpus', runs: exported };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `corbel-${single ? 'run' : 'experiments'}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function addDocument() {
    const title = documentTitle.trim();
    const text = documentText.trim();
    if (!title || !text) return;
    if (binaryControls.test(text)) { error = 'This document contains binary control characters.'; return; }
    if (text.length > DOCUMENT_CHARS_MAX) { error = `This document is over ${documentCharsMax} characters.`; return; }
    const next = [...documents, { id: crypto.randomUUID(), title, text }];
    if (checkDocuments(next)) { error = `Adding this document would exceed the library limit: ${libraryLimits}.`; return; }
    documents = next;
    documentTitle = ''; documentText = ''; addingDocument = false; error = '';
    save();
  }

  async function importFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    error = '';
    for (const file of Array.from(input.files ?? [])) {
      // Byte prefilter before reading: UTF-8 needs at most 3 bytes per UTF-16 unit (plus a 3-byte BOM), so 4x is a safe margin above DOCUMENT_CHARS_MAX.
      if (!/\.(txt|md)$/i.test(file.name) || file.size > DOCUMENT_CHARS_MAX * 4) { error = `Import plain .txt or .md files up to ${documentCharsMax} characters each.`; continue; }
      try {
        const text = await file.text();
        if (!text.trim() || binaryControls.test(text)) { error = `Could not import ${file.name}: empty or binary.`; continue; }
        if (text.length > DOCUMENT_CHARS_MAX) { error = `Could not import ${file.name}: over ${documentCharsMax} characters.`; continue; }
        // Drop a high surrogate the cut left unpaired: the backend rejects invalid Unicode with 422.
        const next = [...documents, { id: crypto.randomUUID(), title: file.name.slice(0, DOCUMENT_TITLE_MAX).replace(/[\uD800-\uDBFF]$/, ''), text }];
        if (checkDocuments(next)) { error = `Could not import ${file.name}: it would exceed the library limit (${libraryLimits}).`; continue; }
        documents = next;
      } catch { error = `Could not read ${file.name}.`; }
    }
    input.value = ''; save();
  }

  function removeDocument(id: string) {
    documents = documents.filter((d) => d.id !== id);
    if (previewDocument?.id === id) previewDocument = null;
    save();
  }

  const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
  const duration = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
</script>

<svelte:head>
  <title>Corbel</title>
    <meta name="description" content="A document Q&A workbench for inspecting retrieval, Laya decisions, and the evidence behind every answer." />
</svelte:head>

<div class="shell">
  <aside class="sidebar">
    <a href="/" class="brand" aria-label="Corbel home"><span class="brand-mark">C<span></span></span><span>corbel<span class="brand-caption">EVIDENCE WORKBENCH</span></span></a>
    <div class="workspace-label">WORKSPACE <span>01</span></div>
    <nav aria-label="Main navigation">
      {#each [{ id: 'workbench', label: 'Q&A workbench', icon: 'grid' }, { id: 'library', label: 'Document library', icon: 'file' }, { id: 'runs', label: 'Experiment log', icon: 'activity' }, { id: 'architecture', label: 'Architecture', icon: 'layers' }] as item}
        <button class:active={tab === item.id} onclick={() => { tab = item.id; error = ''; }} aria-current={tab === item.id ? 'page' : undefined}><Icon name={item.icon} size={19} />{item.label}{#if item.id === 'library'}<span class="nav-count">{documents.length}</span>{/if}</button>
      {/each}
    </nav>
    <div class="sidebar-note"><span class="tiny-label">THE EXPERIMENT</span><p>Less generation.<br />More evidence.</p><span>Explore what a decision model can actually tell you.</span></div>
    <div class="sidebar-bottom"><a href="https://huggingface.co/convaiinnovations/laya" target="_blank" rel="noreferrer">Open model card <Icon name="external" size={14} /></a><div class="local-badge"><span class="status-dot"></span> Local workspace <span>v0.1</span></div></div>
  </aside>

  <main>
    <header class="topbar"><div><span class="breadcrumb">Workspace</span><span class="slash">/</span>{currentTitle}</div><button class="connection" onclick={refreshHealth} title={health.message || 'Refresh model status'}><span class="status-dot" class:online={health.status === 'ready'} class:loading={health.status === 'loading'}></span>Laya {health.status === 'ready' ? 'connected' : health.status}<Icon name="activity" size={15} /></button></header>

    <div class="page">
      <div class="page-heading"><div><div class="eyebrow">RETRIEVE. EVALUATE. INSPECT.</div><h1>{currentTitle}</h1><p>{tab === 'workbench' ? 'Ask your documents. Inspect the evidence.' : tab === 'library' ? 'The source material behind every decision.' : tab === 'runs' ? 'Keep the results. Investigate the mistakes.' : 'A decision model in a retrieval pipeline.'}</p></div><button class="button secondary" onclick={() => exportRuns()} disabled={!runs.length}><Icon name="download" size={17} />Export runs</button></div>

      {#if storageNotice}<div class="notice" role="status">{storageNotice}</div>{/if}
      {#if error}<div class="notice error" role="alert">{error}<button class="icon-button" aria-label="Dismiss error" onclick={() => error = ''}><Icon name="close" size={16} /></button></div>{/if}

      {#if tab === 'workbench'}
        <div class="metrics">
          <div class="metric"><div class="metric-label">Knowledge base <Icon name="file" size={16} /></div><div class="metric-value">{documents.length}<span>documents</span></div><div class="metric-foot">{documents.some((d) => d.sample) ? 'Includes fictional sample documents' : 'Stored in this browser'}</div></div>
          <div class="metric"><div class="metric-label">Decision engine <Icon name="layers" size={16} /></div><div class="metric-value model-name">Laya<span>{health.model || 'english'}</span></div><div class="metric-foot">{health.status === 'ready' ? `${health.gpu || health.device?.toUpperCase()} · ${health.location}` : health.status === 'loading' ? 'Downloading or loading weights' : 'Waiting for the model service'}</div></div>
          <div class="metric"><div class="metric-label">Output mode <Icon name="shield" size={16} /></div><div class="metric-value model-name">Extractive</div><div class="metric-foot">Verbatim sources, no generated prose</div></div>
          <div class="metric"><div class="metric-label">Observed latency <Icon name="clock" size={16} /></div><div class="metric-value">{meanLatency !== null ? duration(meanLatency) : '—'}</div><div class="metric-foot">{runs.length ? `Mean over ${runs.length} local runs` : 'Measured after your first query'}</div></div>
        </div>

        <div class="workbench-grid">
          <div class="query-column">
            <section class="panel query-panel"><div class="panel-heading"><h2><Icon name="search" size={18} />Ask a question</h2><span class="tag">DOCUMENT Q&A</span></div>
              <form onsubmit={(e) => { e.preventDefault(); void ask(); }}>
                <label class="sr-only" for="query">Question</label><textarea id="query" class="question-input" bind:value={query} maxlength={QUERY_MAX} rows="3" placeholder="What would you like to know?" disabled={busy}></textarea>
                <div class="query-controls"><span><Icon name="file" size={14} />{documents.length} documents in scope</span><button class="button primary" type="submit" disabled={busy || !!checkQuery(query) || !documents.length || health.status !== 'ready'}>{busy ? 'Evaluating…' : 'Run query'}{#if busy}<span class="spinner"></span>{:else}<Icon name="arrow" size={17} />{/if}</button></div>
              </form>
              <div class="examples"><span>TRY A QUESTION</span>{#each exampleQuestions as example}<button onclick={() => query = example} disabled={busy}>{example}<Icon name="arrow" size={13} /></button>{/each}</div>
            </section>

            <section class="panel answer-panel" aria-live="polite"><div class="panel-heading"><h2>Evidence-backed result</h2>{#if activeRun}<span class="tag" class:green={accepted.length > 0}>{accepted.length ? 'EVIDENCE FOUND' : 'ABSTAINED'}</span>{:else}<span class="tag">AWAITING QUERY</span>{/if}</div>
              {#if busy}<div class="empty-result"><span class="large-icon"><Icon name="activity" size={29} /></span><h3>Reading the evidence</h3><p>Retrieving passages and evaluating them with Laya.<br />The first inference can take longer.</p><div class="progress-track"><span></span></div></div>
              {:else if activeRun}
                <div class="result-body"><div class="result-query">{activeRun.query}</div>
                  {#if accepted.length}<p class="result-caption">Source passages above the {percent(threshold)} support threshold:</p>{#each accepted as item}<div class="quote"><blockquote>{item.evaluatedText}</blockquote><button onclick={() => selectedEvidence = activeRun!.evidence.indexOf(item)}><span class="citation">{activeRun.evidence.indexOf(item) + 1}</span>{item.title}<Icon name="arrow" size={14} /></button></div>{/each}
                  {:else}<div class="abstention"><Icon name="shield" size={26} /><h3>Insufficient evidence to answer</h3><p>{activeRun.evidence.length ? 'None of the retrieved passages met your acceptance threshold. Inspect the candidates or add a more relevant source.' : 'No passages matched the question terms. Try a different phrasing or add a relevant document. Laya was not called.'}</p></div>{/if}
                  <div class="result-meta"><span><Icon name="clock" size={14} />{duration(activeRun.latencyMs)} total</span><span>{activeRun.evidence.length} candidates</span><span>{activeRun.model}</span><button onclick={() => exportRuns(true)} aria-label="Export this run"><Icon name="download" size={15} /></button></div>
                  <div class="review-row"><span>Is this evidence decision correct?</span><button class:chosen={activeRun.review === 'correct'} onclick={() => review('correct')}>Yes</button><button class:chosen={activeRun.review === 'incorrect'} onclick={() => review('incorrect')}>No</button></div>
                </div>
              {:else}<div class="empty-result"><span class="large-icon"><Icon name="layers" size={30} /></span><h3>The source is the answer.</h3><p>Run a question to see which passages Laya accepts,<br />which it rejects, and why the threshold matters.</p><div class="mini-flow"><span>Retrieve</span><Icon name="arrow" size={13} /><span>Score</span><Icon name="arrow" size={13} /><span>Cite or abstain</span></div></div>{/if}
            </section>
            <div class="integrity-note"><Icon name="shield" size={18} /><p><strong>Constrained output is not a truth guarantee.</strong> Laya can select the wrong evidence. Scores are model estimates, not verified accuracy.</p></div>
          </div>

          <aside class="inspector-column">
            <section class="panel settings-panel"><div class="panel-heading"><h2><Icon name="settings" size={18} />Retrieval settings</h2></div><div class="settings-body"><div class="setting-label"><label for="threshold">Acceptance threshold</label><output for="threshold">{percent(threshold)}</output></div><input id="threshold" type="range" min="0.5" max="0.99" step="0.01" bind:value={threshold} /><div class="range-labels"><span>More coverage</span><span>More selective</span></div><div class="setting-row"><label for="topk">Candidate passages</label><select id="topk" bind:value={topK} disabled={busy}>{#each [2, 4, 6, 8] as k}<option value={k}>Top {k}</option>{/each}</select></div><div class="setting-row"><span>First-stage retrieval</span><span class="mono">BM25</span></div><p class="settings-note">Threshold changes update the result instantly. Candidate count applies to the next query.</p></div></section>
            <section class="panel evidence-panel"><div class="panel-heading"><h2>Evidence inspector</h2><span class="count-badge">{activeRun?.evidence.length ?? 0}</span></div>
              {#if activeRun?.evidence.length}<div class="candidate-list">{#each activeRun.evidence as item, i}<button class="candidate" class:selected={selectedEvidence === i} onclick={() => selectedEvidence = i}><span class="citation">{i + 1}</span><span class="candidate-title">{item.title}<small>{item.probability >= threshold ? 'Accepted' : 'Below threshold'} · BM25 {item.lexicalScore.toFixed(2)}</small></span><strong class:positive={item.probability >= threshold}>{percent(item.probability)}</strong></button>{/each}</div>
                {#if inspected}<div class="inspection"><div class="tiny-label">MODEL DISTRIBUTION</div>{#each Object.entries(inspected.distribution) as [label, probability]}<div class="distribution-label"><span>{label}</span><span>{percent(probability)}</span></div><div class="distribution-track"><span style:width={`${probability * 100}%`} class:supported={label === 'supported'}></span></div>{/each}<div class="inspection-source"><span class="tiny-label">EVALUATED SOURCE TEXT</span><p>{inspected.evaluatedText}</p><span class="source-offset">Characters {inspected.offset + 1}–{inspected.offset + inspected.evaluatedText.length} · {inspected.truncated ? 'Trimmed to model context' : 'Full retrieved passage'}</span></div></div>{/if}
              {:else}<div class="empty-inspector"><div class="placeholder-lines"><span></span><span></span><span></span></div><p>Every candidate, every score.<br />Your retrieval trace will appear here.</p></div>{/if}
            </section>
          </aside>
        </div>
        <div class="pipeline-strip"><span class="tiny-label">YOUR PIPELINE</span><span><b>01</b> Documents</span><Icon name="arrow" size={14} /><span><b>02</b> BM25 retrieval</span><Icon name="arrow" size={14} /><span><b>03</b> Laya decisions</span><Icon name="arrow" size={14} /><span><b>04</b> Cited excerpts</span><button onclick={() => tab = 'architecture'} aria-label="Inspect pipeline architecture"><Icon name="external" size={15} /></button></div>
      {:else if tab === 'library'}
        <div class="library-toolbar"><span>{documents.length} / {DOCUMENTS_MAX} documents · {(documents.reduce((n, d) => n + d.text.length, 0) / 1000).toFixed(1)}k / {CORPUS_CHARS_MAX / 1000}k characters</span><div><button class="button secondary" onclick={() => fileInput?.click()}><Icon name="download" size={16} />Import files</button><button class="button primary" onclick={() => addingDocument = !addingDocument}><Icon name="plus" size={16} />Paste document</button></div></div>
        <input class="sr-only" type="file" accept=".txt,.md" multiple bind:this={fileInput} onchange={importFiles} aria-label="Import text or Markdown documents" />
        {#if addingDocument}<form class="panel document-form" onsubmit={(e) => { e.preventDefault(); addDocument(); }}><h2>Add a source</h2><label for="doc-title">Document title</label><input id="doc-title" bind:value={documentTitle} maxlength={DOCUMENT_TITLE_MAX} required placeholder="e.g. Installation specification.md" /><label for="doc-text">Source text</label><textarea id="doc-text" bind:value={documentText} rows="8" maxlength={DOCUMENT_CHARS_MAX} required placeholder="Paste the complete source text…"></textarea><div class="form-actions"><button class="button secondary" type="button" onclick={() => addingDocument = false}>Cancel</button><button class="button primary">Add document</button></div></form>{/if}
        <div class="notice"><Icon name="file" size={18} />Plain text and Markdown only. Documents stay in this browser and are sent to your configured backend when you run a query. Sample documents describe a fictional installation.</div>
        <div class="document-grid">{#each documents as doc}<article class="panel document-card"><div class="document-card-top"><span class="document-icon"><Icon name="file" size={25} /></span><span class="tag">{doc.sample ? 'SAMPLE' : 'LOCAL'}</span></div><h2>{doc.title}</h2><p>{doc.text.slice(0, 160)}…</p><div class="document-card-bottom"><span>{doc.text.length.toLocaleString()} characters</span><button onclick={() => previewDocument = doc}>Read source <Icon name="arrow" size={14} /></button><button class="icon-button" aria-label={`Remove ${doc.title}`} onclick={() => removeDocument(doc.id)}><Icon name="close" size={16} /></button></div></article>{/each}</div>
        {#if !documents.length}<div class="panel empty-result"><h3>Your library is empty</h3><p>Import a text file or paste a document to start.</p><button class="button secondary" onclick={() => { documents = structuredClone(samples); save(); }}>Load sample documents</button></div>{/if}
        {#if previewDocument}<section class="panel document-preview"><div class="panel-heading"><h2>{previewDocument.title}</h2><button class="icon-button" aria-label="Close source preview" onclick={() => previewDocument = null}><Icon name="close" /></button></div><pre>{previewDocument.text}</pre></section>{/if}
      {:else if tab === 'runs'}
        <div class="metrics three"><div class="metric"><span class="metric-label">Saved experiments</span><div class="metric-value">{runs.length}<span>/ 20 latest</span></div></div><div class="metric"><span class="metric-label">Manually reviewed</span><div class="metric-value">{reviewed.length}</div></div><div class="metric"><span class="metric-label">Marked correct</span><div class="metric-value">{reviewed.length ? percent(selectedCorrect / reviewed.length) : '—'}<span>of reviewed runs</span></div></div></div>
        <p class="muted">Exploratory, self-reviewed runs are not a held-out accuracy benchmark. Exports include evaluated passages, model revision, scores, settings, and timings.</p>
        <section class="panel run-list"><div class="panel-heading"><h2>Recent experiments</h2><span class="tag">BROWSER STORAGE</span></div>{#if runs.length}{#each runs as run}<button class="run-row" onclick={() => openRun(run)}><span class="run-symbol"><Icon name="activity" size={19} /></span><span class="run-question">{run.query}<small>{new Date(run.createdAt).toLocaleString('en-GB')} · {run.model} · threshold {percent(run.threshold)}</small></span><span class="tag" class:green={run.evidence.some((e) => e.probability >= run.threshold)}>{run.evidence.some((e) => e.probability >= run.threshold) ? 'EVIDENCE' : 'ABSTAINED'}</span><span class="run-review">{run.review || 'Unreviewed'}</span><span class="mono">{duration(run.latencyMs)}</span><Icon name="arrow" size={17} /></button>{/each}{:else}<div class="empty-result"><Icon name="activity" size={30} /><h3>No experiments yet</h3><p>Run your first document question to start collecting evidence.</p><button class="button primary" onclick={() => tab = 'workbench'}>Open workbench<Icon name="arrow" size={16} /></button></div>{/if}</section>
      {:else}
        <div class="architecture-banner"><div class="eyebrow">THE WORKING HYPOTHESIS</div><h2>Constrain the output.<br />Inspect the decision.</h2><p>Laya scores a supplied answer space. Here, that space is <code>supported</code>, <code>partial</code>, or <code>irrelevant</code>. Our application returns source excerpts only when the support score clears the threshold.</p></div>
        <div class="architecture-grid">{#each [{ n: '01', title: 'Retrieve candidates', text: 'BM25 ranks paragraph-aligned chunks (about 320 characters) by query terms. Short passages score more reliably than whole documents. It is a lexical baseline; semantic paraphrases can be missed. Laya does not perform this retrieval.' }, { n: '02', title: 'Make a typed decision', text: 'The English checkpoint uses a bidirectional ModernBERT encoder and a decision head. Each option is scored at a marker token, then normalized over the three choices.' }, { n: '03', title: 'Apply the threshold', text: 'The application checks P(supported), not the SDK entropy-based confidence. Raising the threshold trades coverage for selectivity; it does not certify factual correctness.' }, { n: '04', title: 'Return inspectable evidence', text: 'Accepted passages are quoted verbatim with source offsets. If nothing passes, the application abstains. No language model generates the displayed answer.' }] as step}<section class="panel architecture-card"><span class="step-number">{step.n}</span><h2>{step.title}</h2><p>{step.text}</p></section>{/each}</div>
        <div class="research-grid"><section class="panel research-card"><h2>What “zero hallucinations” leaves out</h2><p>A finite answer space rules out invented prose. It still permits the wrong label, irrelevant evidence, stale sources, and confident mistakes.</p><p>Training with a proper scoring rule encourages honest probability estimates in expectation. It does not prove that a finite model is calibrated on a new corpus.</p><a href="https://huggingface.co/convaiinnovations/laya#honest-limits" target="_blank" rel="noreferrer">Read the model’s stated limits <Icon name="external" size={15} /></a></section><section class="panel research-card"><h2>An experiment worth writing about</h2><p>Compare BM25 alone with BM25 + Laya on a fixed, labeled question set. Include answerable, unanswerable, contradictory, and paraphrased questions.</p><p>Measure retrieval recall, accepted-evidence precision, coverage, false acceptance, calibration, and end-to-end latency. Keep calibration data separate from evaluation data.</p><a href="https://github.com/NandhaKishorM/laya" target="_blank" rel="noreferrer">Inspect the upstream implementation <Icon name="external" size={15} /></a></section></div>
        <div class="notice">This prototype batches candidate passages in one forward pass, uses the English checkpoint by default, and has no corpus-specific calibration or generative answer stage. Configure another checkpoint with LAYA_MODEL and restart the backend.</div>
      {/if}
      <footer><span>Corbel <span class="footer-divider">/</span> Evidence-backed Q&A on Laya</span><span>Self-hosted inference. Inspectable decisions.</span></footer>
    </div>
  </main>
</div>


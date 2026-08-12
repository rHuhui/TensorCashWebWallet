(function () {
  'use strict';

  const manifestUrl = './verification-manifest.json';
  const elements = {
    button: document.getElementById('verify-button'),
    card: document.getElementById('result-card'),
    orb: document.getElementById('result-orb'),
    label: document.getElementById('result-label'),
    title: document.getElementById('result-title'),
    message: document.getElementById('result-message'),
    progress: document.getElementById('result-progress'),
    version: document.getElementById('manifest-version'),
    commit: document.getElementById('manifest-commit'),
    summary: document.getElementById('file-summary'),
    files: document.getElementById('file-list'),
  };

  function hexadecimal(bytes) {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(bytes) {
    return hexadecimal(await crypto.subtle.digest('SHA-256', bytes));
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function resultState(state, title, message) {
    elements.card.className = `result-card is-${state}`;
    elements.label.textContent = state === 'success' ? 'VERIFIED' : state === 'failure' ? 'NOT VERIFIED' : 'VERIFYING BUILD';
    elements.title.textContent = title;
    elements.message.textContent = message;
    elements.orb.firstElementChild.textContent = state === 'success' ? '✓' : state === 'failure' ? '!' : '···';
  }

  function renderFile(file) {
    const row = document.createElement('div');
    const name = document.createElement('div');
    const size = document.createElement('div');
    const status = document.createElement('div');
    row.className = 'file-row is-pending';
    name.className = 'file-name';
    size.className = 'file-size';
    status.className = 'file-status';
    name.textContent = file.path;
    name.title = file.path;
    size.textContent = formatBytes(file.size);
    status.textContent = 'Waiting';
    row.append(name, size, status);
    elements.files.appendChild(row);
    return { row, status };
  }

  async function verify() {
    elements.button.disabled = true;
    elements.button.textContent = '正在验证…';
    elements.files.replaceChildren();
    elements.progress.style.width = '0%';
    elements.summary.textContent = '—';
    resultState('running', '正在读取公开构建清单', '随后将直接下载线上钱包文件并计算 SHA-256。');

    try {
      const manifestResponse = await fetch(`${manifestUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!manifestResponse.ok) throw new Error(`无法读取 GitHub 构建清单（HTTP ${manifestResponse.status}）`);
      const manifest = await manifestResponse.json();
      if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error('GitHub 构建清单格式无效');
      }

      const target = new URL(manifest.target);
      elements.version.textContent = `v${manifest.version}`;
      elements.commit.textContent = String(manifest.commit).slice(0, 12);
      elements.commit.href = manifest.source;
      const rows = manifest.files.map(renderFile);
      let matches = 0;
      let failures = 0;

      for (let index = 0; index < manifest.files.length; index += 1) {
        const file = manifest.files[index];
        const row = rows[index];
        resultState('running', `正在校验 ${file.path}`, `${index + 1} / ${manifest.files.length} 个文件`);
        try {
          const url = new URL(file.path, target);
          url.searchParams.set('wallet-build-verifier', String(Date.now()));
          const response = await fetch(url, { cache: 'no-store', credentials: 'omit', mode: 'cors' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          const digest = await sha256(bytes);
          const matchesExpected = digest === file.sha256 && bytes.byteLength === file.size;
          row.row.className = `file-row ${matchesExpected ? 'is-match' : 'is-mismatch'}`;
          row.status.textContent = matchesExpected ? 'Match' : 'Mismatch';
          row.row.title = matchesExpected ? `SHA-256 ${digest}` : `Expected ${file.sha256}\nReceived ${digest}`;
          if (matchesExpected) matches += 1;
          else failures += 1;
        } catch (problem) {
          row.row.className = 'file-row is-error';
          row.status.textContent = 'Error';
          row.row.title = problem instanceof Error ? problem.message : String(problem);
          failures += 1;
        }
        elements.progress.style.width = `${Math.round(((index + 1) / manifest.files.length) * 100)}%`;
      }

      elements.summary.textContent = `${matches} / ${manifest.files.length} 匹配`;
      if (failures === 0) {
        resultState('success', '线上钱包与公开构建完全一致', `已验证 v${manifest.version} 的 ${matches} 个文件；所有 SHA-256 均匹配。`);
      } else {
        resultState('failure', '线上钱包与公开构建不一致', `${failures} 个文件缺失、无法读取或哈希不匹配。请暂勿进行敏感操作。`);
      }
    } catch (problem) {
      resultState('failure', '无法完成验证', problem instanceof Error ? problem.message : String(problem));
      elements.summary.textContent = '验证失败';
    } finally {
      elements.button.disabled = false;
      elements.button.textContent = '重新验证';
    }
  }

  if (!window.crypto?.subtle) {
    resultState('failure', '当前浏览器不支持安全哈希', '请使用支持 Web Crypto 的现代浏览器，并通过 HTTPS 打开此页面。');
    elements.button.disabled = true;
  } else {
    elements.button.addEventListener('click', verify);
    verify();
  }
}());

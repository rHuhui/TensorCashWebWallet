(function () {
  "use strict";

  const manifestUrl = "./verification-manifest.json";
  const elements = {
    button: document.getElementById("verify-button"),
    card: document.getElementById("result-card"),
    orb: document.getElementById("result-orb"),
    label: document.getElementById("result-label"),
    title: document.getElementById("result-title"),
    message: document.getElementById("result-message"),
    progress: document.getElementById("result-progress"),
    version: document.getElementById("manifest-version"),
    commit: document.getElementById("manifest-commit"),
    summary: document.getElementById("file-summary"),
    files: document.getElementById("file-list"),
  };

  function hexadecimal(bytes) {
    return Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  async function sha256(bytes) {
    return hexadecimal(await crypto.subtle.digest("SHA-256", bytes));
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }

  function resultState(state, title, message) {
    elements.card.className = `result-card is-${state}`;
    elements.label.textContent =
      state === "success"
        ? "VERIFIED"
        : state === "failure"
          ? "NOT VERIFIED"
          : "VERIFYING BUILD";
    elements.title.textContent = title;
    elements.message.textContent = message;
    elements.orb.firstElementChild.textContent =
      state === "success" ? "✓" : state === "failure" ? "!" : "···";
  }

  function renderFile(file) {
    const row = document.createElement("div");
    const identity = document.createElement("div");
    const name = document.createElement("div");
    const size = document.createElement("div");
    const hashes = document.createElement("div");
    const sourceHash = document.createElement("div");
    const sourceLabel = document.createElement("span");
    const sourceValue = document.createElement("code");
    const hostedHash = document.createElement("div");
    const hostedLabel = document.createElement("span");
    const hostedValue = document.createElement("code");
    const status = document.createElement("div");
    row.className = "file-row is-pending";
    identity.className = "file-identity";
    name.className = "file-name";
    size.className = "file-size";
    hashes.className = "file-hashes";
    sourceHash.className = "hash-line";
    hostedHash.className = "hash-line";
    sourceLabel.textContent = "Open-source build";
    hostedLabel.textContent = "Hosted wallet";
    sourceValue.textContent = file.sha256;
    hostedValue.textContent = "Calculating…";
    status.className = "file-status";
    name.textContent = file.path;
    name.title = file.path;
    size.textContent = formatBytes(file.size);
    status.textContent = "Waiting";
    identity.append(name, size);
    sourceHash.append(sourceLabel, sourceValue);
    hostedHash.append(hostedLabel, hostedValue);
    hashes.append(sourceHash, hostedHash);
    row.append(identity, hashes, status);
    elements.files.appendChild(row);
    return { row, status, hostedValue };
  }

  async function verify() {
    elements.button.disabled = true;
    elements.button.textContent = "Verifying…";
    elements.files.replaceChildren();
    elements.progress.style.width = "0%";
    elements.summary.textContent = "—";
    resultState(
      "running",
      "Loading the public build manifest",
      "The verifier will then download the live wallet files and calculate their SHA-256 hashes.",
    );

    try {
      const manifestResponse = await fetch(`${manifestUrl}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!manifestResponse.ok)
        throw new Error(
          `Could not load the GitHub build manifest (HTTP ${manifestResponse.status})`,
        );
      const manifest = await manifestResponse.json();
      if (
        manifest.schema !== 1 ||
        !Array.isArray(manifest.files) ||
        !manifest.files.length
      ) {
        throw new Error("The GitHub build manifest is invalid");
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
        resultState(
          "running",
          `Checking ${file.path}`,
          `File ${index + 1} of ${manifest.files.length}`,
        );
        try {
          const url = new URL(file.path, target);
          url.searchParams.set("wallet-build-verifier", String(Date.now()));
          const response = await fetch(url, {
            cache: "no-store",
            credentials: "omit",
            mode: "cors",
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          const digest = await sha256(bytes);
          row.hostedValue.textContent = digest;
          const matchesExpected =
            digest === file.sha256 && bytes.byteLength === file.size;
          row.row.className = `file-row ${matchesExpected ? "is-match" : "is-mismatch"}`;
          row.status.textContent = matchesExpected ? "Match" : "Mismatch";
          row.row.title = matchesExpected
            ? `SHA-256 ${digest}`
            : `Expected ${file.sha256}\nReceived ${digest}`;
          if (matchesExpected) matches += 1;
          else failures += 1;
        } catch (problem) {
          row.row.className = "file-row is-error";
          row.status.textContent = "Error";
          row.hostedValue.textContent = "Unavailable";
          row.row.title =
            problem instanceof Error ? problem.message : String(problem);
          failures += 1;
        }
        elements.progress.style.width = `${Math.round(((index + 1) / manifest.files.length) * 100)}%`;
      }

      elements.summary.textContent = `${matches} / ${manifest.files.length} matched`;
      if (failures === 0) {
        resultState(
          "success",
          "The hosted wallet matches the open-source build",
          `Verified ${matches} files for v${manifest.version}; every SHA-256 hash and file size matched.`,
        );
      } else {
        resultState(
          "failure",
          "The hosted wallet does not match the open-source build",
          `${failures} files were missing, unreadable, or did not match. Avoid sensitive operations until this is resolved.`,
        );
      }
    } catch (problem) {
      resultState(
        "failure",
        "Verification could not be completed",
        problem instanceof Error ? problem.message : String(problem),
      );
      elements.summary.textContent = "Verification failed";
    } finally {
      elements.button.disabled = false;
      elements.button.textContent = "Verify again";
    }
  }

  if (!window.crypto?.subtle) {
    resultState(
      "failure",
      "Secure hashing is unavailable in this browser",
      "Open this page over HTTPS in a modern browser that supports the Web Crypto API.",
    );
    elements.button.disabled = true;
  } else {
    elements.button.addEventListener("click", verify);
    verify();
  }
})();

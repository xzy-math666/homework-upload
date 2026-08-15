/* 作业提交页逻辑: 选文件 -> 填信息 -> 后端换预签名URL -> 直传OSS */
(function () {
  "use strict";

  // API 服务器 (阿里云函数计算)。页面托管在 GitHub Pages 等第三方域名时用绝对地址;
  // 若页面恰好由函数自己提供, 则用同源相对路径。
  const API_HOST = "https://homework-upload-exygqrzxsj.cn-shenzhen.fcapp.run";
  const API = location.hostname.endsWith(".fcapp.run") || location.hostname.endsWith(".fc.aliyuncs.com") ? "" : API_HOST;

  const $ = (id) => document.getElementById(id);
  const form = $("form"), cls = $("cls"), name = $("name"), sid = $("sid"),
        assign = $("assign"), passcodeBox = $("passcode-box"), passcode = $("passcode"),
        drop = $("drop"), fileInput = $("file-input"), filesList = $("files"),
        btnUpload = $("btn-upload"), btnReset = $("btn-reset"), msg = $("msg");

  let cfg = { passcodeRequired: false, maxSizeMB: 100 };
  let selected = [];          // [{file, el, statusEl, barEl, done}]
  let currentPasscode = "";

  /* ---------- 初始化 ---------- */
  fetch(API + "/api/config")
    .then((r) => r.json())
    .then((c) => {
      cfg = c;
      if (c.passcodeRequired) {
        passcodeBox.style.display = "block";
        currentPasscode = localStorage.getItem("hw_passcode") || "";
        if (currentPasscode) passcode.value = currentPasscode;
      }
      setMsg(`单文件上限 ${c.maxSizeMB}MB`, "");
    })
    .catch(() => setMsg("无法连接服务器, 请刷新重试", "err"));

  function setMsg(text, type) {
    msg.textContent = text;
    msg.className = type || "";
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  /* ---------- 文件选择 ---------- */
  function addFiles(fileList) {
    for (const file of fileList) {
      if (file.size > cfg.maxSizeMB * 1048576) {
        setMsg(`「${file.name}」超过 ${cfg.maxSizeMB}MB 上限, 已跳过`, "err");
        continue;
      }
      const li = document.createElement("li");
      const nameEl = document.createElement("span"); nameEl.className = "name"; nameEl.textContent = file.name;
      const sizeEl = document.createElement("span"); sizeEl.className = "size"; sizeEl.textContent = fmtSize(file.size);
      const barWrap = document.createElement("span"); barWrap.className = "bar-wrap";
      const bar = document.createElement("span"); bar.className = "bar"; barWrap.appendChild(bar);
      const statusEl = document.createElement("span"); statusEl.className = "status"; statusEl.textContent = "待上传";
      li.append(nameEl, sizeEl, barWrap, statusEl);
      filesList.appendChild(li);
      selected.push({ file, el: li, statusEl, barEl: bar, done: false });
    }
    btnUpload.disabled = selected.length === 0;
    btnReset.style.display = "none";
  }

  drop.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("active"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("active"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("active");
    addFiles(e.dataTransfer.files);
  });

  /* ---------- 上传: 先签名, 再直传 OSS ---------- */
  async function signAndUpload(item) {
    const f = item.file;
    item.statusEl.textContent = "签名中…";
    item.statusEl.className = "status";

    // 1) 从后端换取 OSS 预签名上传 URL (1 小时有效)
    let signed;
    try {
      const res = await fetch(API + "/api/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          class: cls.value.trim(),
          studentName: name.value.trim(),
          studentId: sid.value.trim() || "",
          assignment: assign.value.trim() || "",
          filename: f.name,
          contentType: f.type || "application/octet-stream",
          passcode: currentPasscode || "",
        }),
      });
      if (res.status === 401) return { err: "passcode" };
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return { err: d.message || "签名失败" };
      }
      signed = await res.json();
    } catch (e) {
      return { err: "签名服务不可用" };
    }

    // 2) 直传 OSS
    return new Promise((resolve) => {
      item.statusEl.textContent = "上传中";
      item.barEl.style.width = "0%";
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signed.url);
      xhr.setRequestHeader("Content-Type", signed.contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) item.barEl.style.width = Math.round((e.loaded / e.total) * 100) + "%";
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          item.statusEl.textContent = "✅ 成功";
          item.statusEl.className = "status ok";
          item.barEl.style.width = "100%";
          resolve({ ok: true });
        } else {
          item.statusEl.textContent = "❌ 上传失败";
          item.statusEl.className = "status err";
          resolve({ err: "upload_failed" });
        }
      };
      xhr.onerror = () => {
        item.statusEl.textContent = "❌ 网络错误";
        item.statusEl.className = "status err";
        resolve({ err: "network" });
      };
      xhr.send(f);
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!cls.value.trim() || !name.value.trim()) { setMsg("请填写班级和姓名", "err"); return; }
    if (cfg.passcodeRequired) {
      if (!passcode.value.trim()) { setMsg("请填写提交密码", "err"); return; }
      currentPasscode = passcode.value.trim();
      localStorage.setItem("hw_passcode", currentPasscode);
    }

    btnUpload.disabled = true;
    let ok = 0, fail = 0;
    for (const item of selected) {
      if (item.done) continue;                 // 已成功的跳过(重试时用)
      const r = await signAndUpload(item);
      if (r.err === "passcode") { setMsg("提交密码错误, 请重新填写", "err"); btnUpload.disabled = false; return; }
      if (r.ok) { item.done = true; ok++; } else { fail++; }
    }
    if (fail === 0) {
      setMsg(`✅ 全部 ${ok} 个文件上传成功!`, "ok");
      btnReset.style.display = "block";
    } else {
      setMsg(`上传完成: ${ok} 成功, ${fail} 失败(点开始上传重试失败项)`, "err");
      btnUpload.disabled = false;
    }
  });

  btnReset.addEventListener("click", () => {
    filesList.innerHTML = "";
    selected = [];
    setMsg("", "");
    btnReset.style.display = "none";
    btnUpload.disabled = true;
  });
})();

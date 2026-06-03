import fs from 'node:fs/promises';

const urls = [
  "https://cdn.grok.com/_next/static/chunks/07vlc.33b90yz.js",
  "https://cdn.grok.com/_next/static/chunks/0s.6p_agx8ogm.js",
  "https://cdn.grok.com/_next/static/chunks/0uuh7z9qf-wwx.js",
  "https://cdn.grok.com/_next/static/chunks/17nb2q2d2v3ub.js",
  "https://cdn.grok.com/_next/static/chunks/08s9s235o20cm.js",
  "https://cdn.grok.com/_next/static/chunks/turbopack-0ync66~qem~3p.js",
  "https://cdn.grok.com/_next/static/chunks/0mcmg777x5-ui.js",
  "https://cdn.grok.com/_next/static/chunks/0z4g.k7ijml2s.js",
  "https://cdn.grok.com/_next/static/chunks/0685-l3lbtre0.js",
  "https://cdn.grok.com/_next/static/chunks/08q6alqryt_vx.js",
  "https://cdn.grok.com/_next/static/chunks/0p~f-gt-w0t00.js",
  "https://cdn.grok.com/_next/static/chunks/0lhlpq7vbg~-m.js",
  "https://cdn.grok.com/_next/static/chunks/094p5avrdd1xz.js",
  "https://cdn.grok.com/_next/static/chunks/0-q1rppowlyoe.js",
  "https://cdn.grok.com/_next/static/chunks/0tn-rc7zombfp.js",
  "https://cdn.grok.com/_next/static/chunks/0duf6n79rb8w8.js",
  "https://cdn.grok.com/_next/static/chunks/0vljhmqsobo~f.js",
  "https://cdn.grok.com/_next/static/chunks/0jw6t0w~9c09l.js",
  "https://cdn.grok.com/_next/static/chunks/0tm25fe~g226v.js",
  "https://cdn.grok.com/_next/static/chunks/0..oiyekcr85v.js",
  "https://cdn.grok.com/_next/static/chunks/04ti4zutjvvr-.js",
  "https://cdn.grok.com/_next/static/chunks/04y9yt5mt~0-w.js",
  "https://cdn.grok.com/_next/static/chunks/0hhddcmoppd8i.js",
  "https://cdn.grok.com/_next/static/chunks/0wxv_3cefrwir.js",
  "https://cdn.grok.com/_next/static/chunks/0lujo7mjayoib.js",
  "https://cdn.grok.com/_next/static/chunks/13r7dmfp1as9e.js",
  "https://cdn.grok.com/_next/static/chunks/0o-6ox5atvpb9.js",
  "https://cdn.grok.com/_next/static/chunks/0leu9y3w1rvsq.js",
  "https://cdn.grok.com/_next/static/chunks/15_.ccdttfzel.js",
  "https://cdn.grok.com/_next/static/chunks/0pg59hdfptyd-.js",
  "https://cdn.grok.com/_next/static/chunks/0iih3rw30by2-.js",
  "https://cdn.grok.com/_next/static/chunks/0z.ksu0wu9rnb.js",
  "https://cdn.grok.com/_next/static/chunks/17d-nk5i41g~f.js",
  "https://cdn.grok.com/_next/static/chunks/0a80m2fx5smnk.js",
  "https://cdn.grok.com/_next/static/chunks/10y-_-w4zowsg.js",
  "https://cdn.grok.com/_next/static/chunks/0cixo3dtsu8zb.js",
  "https://cdn.grok.com/_next/static/chunks/0xx06g5mjbes4.js",
  "https://cdn.grok.com/_next/static/chunks/0dmrado~bvm1h.js",
  "https://cdn.grok.com/_next/static/chunks/0k5hx32~ur9eg.js",
  "https://cdn.grok.com/_next/static/chunks/05._cw94t_hux.js",
  "https://cdn.grok.com/_next/static/chunks/0pqq0e9jyvop-.js",
  "https://cdn.grok.com/_next/static/chunks/0aj3fnt7b98yl.js",
  "https://cdn.grok.com/_next/static/chunks/0afzoewmq.wb~.js",
  "https://cdn.grok.com/_next/static/chunks/17fgvfpqoq2wd.js",
  "https://cdn.grok.com/_next/static/chunks/0it~-zq5jw4~y.js",
  "https://cdn.grok.com/_next/static/chunks/13jtam.xq0k36.js",
  "https://cdn.grok.com/_next/static/chunks/0f639-q0x3_rm.js",
  "https://cdn.grok.com/_next/static/chunks/0.jo3a4y0dvmb.js",
  "https://cdn.grok.com/_next/static/chunks/0i9311ws3r4n0.js",
  "https://cdn.grok.com/_next/static/chunks/07k0x.9dsgqa9.js",
  "https://cdn.grok.com/_next/static/chunks/141yovfjp3dvc.js",
  "https://cdn.grok.com/_next/static/chunks/0y_kngv7j6vpi.js",
  "https://cdn.grok.com/_next/static/chunks/04lasy0szmlgj.js",
  "https://cdn.grok.com/_next/static/chunks/0l66f7v4n.fw~.js",
  "https://cdn.grok.com/_next/static/chunks/18dnl1a_h.1rr.js",
  "https://cdn.grok.com/_next/static/chunks/0kvwh.v2qinjl.js",
  "https://cdn.grok.com/_next/static/chunks/05x4~.9llbn_8.js",
  "https://cdn.grok.com/_next/static/chunks/0ojpjp8snn7ge.js",
  "https://cdn.grok.com/_next/static/chunks/0ci9d0.e0neh8.js",
  "https://cdn.grok.com/_next/static/chunks/0b1mr85lv55zu.js",
  "https://cdn.grok.com/_next/static/chunks/17xdbzsljkj60.js",
  "https://cdn.grok.com/_next/static/chunks/0s..91vi7prq3.js",
  "https://cdn.grok.com/_next/static/chunks/07pujdh12-j65.js",
  "https://cdn.grok.com/_next/static/chunks/16d7fc-bgf_ij.js",
  "https://cdn.grok.com/_next/static/chunks/0e9vois~jd2n-.js",
  "https://cdn.grok.com/_next/static/chunks/00q~y3dpvh9s_.js",
  "https://cdn.grok.com/_next/static/chunks/0bma0jrx1vlzl.js",
  "https://cdn.grok.com/_next/static/chunks/0a177tnlu30tc.js",
  "https://cdn.grok.com/_next/static/chunks/072vi3kbcx31w.js",
  "https://cdn.grok.com/_next/static/chunks/0yenz-yxsqqmx.js",
  "https://cdn.grok.com/_next/static/chunks/13l3owx3l52un.js",
  "https://cdn.grok.com/_next/static/chunks/0r46cmcin~fkv.js",
  "https://cdn.grok.com/_next/static/chunks/0qyx-m-5db0wu.js",
  "https://cdn.grok.com/_next/static/chunks/0p4vnjr-ks2vp.js",
  "https://cdn.grok.com/_next/static/chunks/0v3adtwhbsx83.js",
  "https://cdn.grok.com/_next/static/chunks/0.3f5~u~c0_e5.js",
  "https://cdn.grok.com/_next/static/chunks/0sfyuu-l._dqy.js",
  "https://cdn.grok.com/_next/static/chunks/0z4hmc0lr9egn.js",
  "https://cdn.grok.com/_next/static/chunks/0ck.07~nhjs8..js",
  "https://cdn.grok.com/_next/static/chunks/0jzbi~8cbdgbq.js",
  "https://cdn.grok.com/_next/static/chunks/10un_-uay8_o7.js",
  "https://cdn.grok.com/_next/static/chunks/0~01fl1hksy._.js",
  "https://cdn.grok.com/_next/static/chunks/0av7gk-~xs6sb.js",
  "https://cdn.grok.com/_next/static/chunks/0vffadg0eam-i.js",
  "https://cdn.grok.com/_next/static/chunks/0zh0zheszqy5z.js",
  "https://cdn.grok.com/_next/static/chunks/0ovo786k4aq-4.js",
  "https://cdn.grok.com/_next/static/chunks/125x_chz-g00o.js",
  "https://cdn.grok.com/_next/static/chunks/0pr6dgb.n.b5l.js",
  "https://cdn.grok.com/_next/static/chunks/0vmoudp3bql2~.js",
  "https://cdn.grok.com/_next/static/chunks/16hl9j_cv.o0j.js",
  "https://cdn.grok.com/_next/static/chunks/02a4gnknmgdwh.js",
  "https://cdn.grok.com/_next/static/chunks/0fu.dfn5.e6qf.js",
  "https://cdn.grok.com/_next/static/chunks/0fx9gx6dx3szp.js",
  "https://cdn.grok.com/_next/static/chunks/10qnrpiz~x5sv.js",
  "https://cdn.grok.com/_next/static/chunks/0u6zwfi5cum54.js",
  "https://cdn.grok.com/_next/static/chunks/0-nt7.8hplhm5.js"
];

async function resolveStatsigDynamically() {
  console.log("Starting dynamic statsig resolution...");

  // 1. Fetch chunks in parallel to find the one containing "x-statsig-id"
  const chunkTexts = {};
  const fetchPromises = urls.map(async (url) => {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        chunkTexts[url] = text;
      }
    } catch {}
  });

  await Promise.all(fetchPromises);

  let middlewareUrl = null;
  let statsigModuleId = null;

  for (const [url, text] of Object.entries(chunkTexts)) {
    if (text.includes("x-statsig-id")) {
      middlewareUrl = url;
      console.log("Found middleware chunk:", url);
      
      // Extract the module ID:
      // Pattern: e.A(4629918).then(e=>t(e.default()))
      // Let's use a regex that matches `[a-zA-Z_]\.[a-zA-Z_0-9]+\((\d+)\)\.then\(`
      const match = /\.([a-zA-Z_0-9]+)\((\d+)\)\.then\(/g.exec(text);
      if (match) {
        statsigModuleId = match[2];
        console.log(`Extracted statsigModuleId: ${statsigModuleId} (called via function ${match[1]})`);
        break;
      }
    }
  }

  if (!middlewareUrl || !statsigModuleId) {
    console.log("Could not find statsig module ID in chunks");
    return;
  }

  // 2. Find which chunk defines this statsigModuleId
  let generatorChunkRelativePath = null;
  let targetInnerModuleId = null;

  for (const [url, text] of Object.entries(chunkTexts)) {
    // Pattern: 4629918,s=>{s.v(t=>Promise.all(["static/chunks/0av7gk-~xs6sb.js"].map(t=>s.l(t))).then(()=>t(1645e3)))}
    // Let's search using a regex:
    const regexStr = statsigModuleId + '\\s*,\\s*[a-zA-Z_0-9]+\\s*=>\\s*\\{\\s*[a-zA-Z_0-9]+\\.v\\(\\s*[a-zA-Z_0-9]+\\s*=>\\s*Promise\\.all\\(\\s*\\[\\s*([^\\s\\]]+)\\s*\\]\\)\\.then\\(\\s*\\(\\)\\s*=>\\s*([a-zA-Z_0-9]+)\\s*=>\\s*\\2\\(([^\\)]+)\\)\\)\\s*\\)\\}';
    
    // Simpler regex to match the promise dynamic import path and inner module ID:
    // e.g. 4629918,s=>{s.v(t=>Promise.all(["static/chunks/0av7gk-~xs6sb.js"].map(t=>s.l(t))).then(()=>t(1645e3)))}
    const simpleRegex = new RegExp(statsigModuleId + '\\s*,\\s*[a-zA-Z_0-9]+\\s*=>\\s*\\{\\s*[a-zA-Z_0-9]+\\.v\\(\\s*[a-zA-Z_0-9]+\\s*=>\\s*Promise\\.all\\(\\s*\\[\\s*"([^"]+)"\\s*\\]\\s*\\)\\.map[^\\)]*\\)\\.then\\(\\s*\\(\\)\\s*=>\\s*[a-zA-Z_0-9]+\\s*=>\\s*[a-zA-Z_0-9]+\\(([^\\)]+)\\)\\)\\s*\\)\\}');
    
    // Let's do a broad regex:
    const broadRegex = new RegExp(statsigModuleId + '[^}]+?"(static/chunks/[^"]+)"[^}]+?\\.then\\(\\(\\)\\s*=>\\s*[a-zA-Z_0-9]+\\(([^\\)]+)\\)\\)');
    const match = broadRegex.exec(text);
    if (match) {
      generatorChunkRelativePath = match[1];
      targetInnerModuleId = match[2];
      console.log(`Found registration in chunk: ${url}`);
      console.log(`Generator chunk relative path: ${generatorChunkRelativePath}`);
      console.log(`Inner module ID: ${targetInnerModuleId}`);
      break;
    }
  }

  if (!generatorChunkRelativePath || !targetInnerModuleId) {
    console.log("Could not find dynamic import definition for statsig module");
    return;
  }

  // 3. Download the generator chunk and intercept
  const generatorUrl = `https://cdn.grok.com/_next/${generatorChunkRelativePath}`;
  console.log("Fetching generator chunk from:", generatorUrl);
  const genRes = await fetch(generatorUrl);
  const generatorScript = await genRes.ok ? await genRes.text() : "";
  if (!generatorScript) {
    console.log("Failed to fetch generator chunk");
    return;
  }

  // 4. Resolve the inner module ID if it's in scientific notation (e.g. 1645e3 -> 1645000)
  let numericModuleId = Number(targetInnerModuleId);
  if (isNaN(numericModuleId)) {
    // Try evaluating it
    try {
      numericModuleId = eval(targetInnerModuleId);
    } catch {
      console.log("Could not parse targetInnerModuleId:", targetInnerModuleId);
      return;
    }
  }

  console.log("Resolved target numeric module ID:", numericModuleId);

  // Return the necessary configuration
  return {
    generatorUrl,
    numericModuleId,
    statsigModuleId: Number(statsigModuleId)
  };
}

async function main() {
  const result = await resolveStatsigDynamically();
  console.log("Result:", result);
}

main();

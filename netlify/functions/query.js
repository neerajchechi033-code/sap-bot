const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_KEY}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const { question } = JSON.parse(event.body);
    if (!question) return { statusCode: 400, body: JSON.stringify({ error: "question required" }) };

    const { data: custNames } = await supabase.from("sales_orders").select("name1").not("name1", "is", null);
    const uniqueNames = [...new Set((custNames || []).map(r => r.name1).filter(Boolean))];

    const now = new Date();
    const fyStart = now.getMonth() >= 3 ? now.getFullYear() + "-04-01" : (now.getFullYear() - 1) + "-04-01";
    const fyEnd = now.getMonth() >= 3 ? (now.getFullYear() + 1) + "-03-31" : now.getFullYear() + "-03-31";

    const systemPrompt = `You are a SAP data assistant for Rotex Automation. Answer questions about sales orders and invoices in Supabase.
Tables: 1) sales_orders: vbeln, erdat, kunnr, name1, netwr, waerk, auart, vkorg, status(PENDING/PARTIAL/DISPATCHED), gbstk
2) invoices: vbeln, fkdat, kunnr, name1, netwr, mwsbk, waerk, fkart, so_num
Current Indian FY: ${fyStart} to ${fyEnd}
Customer names: ${uniqueNames.slice(0, 200).join(", ")}
Return ONLY valid JSON: {"table":"sales_orders|invoices","date_from":"YYYY-MM-DD|null","date_to":"YYYY-MM-DD|null","status_filter":"PENDING|DISPATCHED|PARTIAL|null","customer_name":"exact matched name|null","aggregation":"count|sum_netwr|list|null","limit":20,"answer_prefix":"intro line in user language"}`;

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: "user", parts: [{ text: question }] }] })
    });
    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const cleanText = rawText.replace(/\`\`\`json\n?|\`\`\`/g, "").trim();

    let parsed;
    try { parsed = JSON.parse(cleanText); } catch { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: rawText }) }; }

    const table = parsed.table || "sales_orders";
    let query = supabase.from(table).select("*");
    const dateCol = table === "invoices" ? "fkdat" : "erdat";
    if (parsed.date_from) query = query.gte(dateCol, parsed.date_from);
    if (parsed.date_to) query = query.lte(dateCol, parsed.date_to);
    if (parsed.status_filter) query = query.eq("status", parsed.status_filter);
    if (parsed.customer_name) query = query.ilike("name1", "%" + parsed.customer_name + "%");
    if (parsed.filters?.vkorg) query = query.eq("vkorg", parsed.filters.vkorg);
    query = query.order(dateCol, { ascending: false }).limit(parsed.limit || 50);

    const { data: rows, error: dbErr } = await query;
    if (dbErr) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "DB Error: " + dbErr.message }) };

    let answer = parsed.answer_prefix || "";
    if (parsed.aggregation === "count") {
      answer += "\n\nTotal: **" + rows.length + "** records found.";
    } else if (parsed.aggregation === "sum_netwr") {
      const total = rows.reduce((s, r) => s + (parseFloat(r.netwr) || 0), 0);
      const formatted = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(total);
      answer += "\n\nTotal Value: **" + formatted + "** (" + rows.length + " records)";
    }
    if (rows.length > 0 && parsed.aggregation !== "count") {
      const display = rows.slice(0, 20);
      if (table === "sales_orders") {
        answer += "\n\n| Order | Customer | Date | Value | Status |\n|---|---|---|---|---|\n";
        display.forEach(r => { answer += "| " + r.vbeln + " | " + (r.name1||r.kunnr) + " | " + r.erdat + " | " + new Intl.NumberFormat("en-IN").format(r.netwr||0) + " | " + (r.status||"-") + " |\n"; });
      } else {
        answer += "\n\n| Invoice | Customer | Date | Net Value | Tax |\n|---|---|---|---|---|\n";
        display.forEach(r => { answer += "| " + r.vbeln + " | " + (r.name1||r.kunnr) + " | " + r.fkdat + " | " + new Intl.NumberFormat("en-IN").format(r.netwr||0) + " | " + new Intl.NumberFormat("en-IN").format(r.mwsbk||0) + " |\n"; });
      }
      if (rows.length > 20) answer += "\n*...aur " + (rows.length - 20) + " rows hain*";
    } else if (rows.length === 0) { answer += "\n\nKoi data nahi mila is filter ke liye."; }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) };
  } catch (err) {
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "Error: " + err.message }) };
  }
};

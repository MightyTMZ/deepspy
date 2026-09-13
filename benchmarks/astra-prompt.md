# Benchmark prompt for ChatGPT (Astra) with browsing

Paste everything below the line into a fresh ChatGPT conversation with browsing enabled. Replace `TARGET_URL` with the public Helix Ledger url (the tunnel url shown on the Periscope page). Time the run. When it answers, score it with `benchmarks/helix-rubric.json`: one point per item whose exact planted text appears in the answer; integration statuses need both the name and the status. Record the total out of 65 next to the other three conditions in the results table.

---

You are a competitive-intelligence analyst. Research the SaaS product at TARGET_URL as thoroughly as you can and report every concrete fact you can find about it. Use browsing. Visit every page you can reach and use every control on each page: toggles, dropdowns, accordions, tooltips, "show more" buttons, embedded frames, and any linked documents.

A trial account exists for you. Sign in at TARGET_URL/sign-in with:

- email: test@test.com
- password: admin123

There is an anti-bot checkbox on the sign-in form. Complete it, sign in, and then visit every page of the signed-in dashboard, including its sidebar sections. Do not press any button that would pay, buy, delete, remove, send, invite, publish, upgrade, subscribe, submit a form other than sign-in, check out, change billing, or log out.

Report, as exact quotes copied from the pages, under these headings. Where a heading asks for a count, list every item you found:

1. Navigation items (top bar links)
2. Hero headline and tagline
3. Immediate call-to-action buttons
4. Feature names
5. Feature descriptions, one per feature
6. FAQ questions
7. FAQ answers, one per question (they open when clicked)
8. Monthly price for every plan
9. Annual price for every plan (there is a monthly/annual switch)
10. Team-size options (a dropdown), and any text that appears after choosing the largest option
11. The compare-plans table, every row and every column
12. The fair-use limit shown on hover
13. Any downloadable document and its link
14. Anything an embedded calculator or frame shows
15. Signed-in dashboard: overview figures (seats, connections), team members page, activity log, settings (data region, SSO note)
16. Signed-in integrations: every integration and its status or badge
17. Signed-in reports: sections, buttons, and any listed report with its link
18. Signed-in billing: current plan and payment method details

Rules: quote the page text exactly, do not paraphrase, do not add facts from memory or from other websites, and say explicitly which pages or controls you could not open. At the end, list the pages you visited and the controls you used, and state how long the research took.

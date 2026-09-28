// Server instructions, shared by the daemon (mcp.ts) and the stdio shim so every host sees them.
export const INSTRUCTIONS = `Posts used-item ads to Blocket, Tradera, Facebook Marketplace and Vinted. For the full interview and ad-writing rules, use the post_ad prompt.

Workflow per item:
1. add_photos(slug, folder) and look at the thumbnails.
2. Ask the user for missing facts (type, brand/model, condition + defects, price SEK and negotiable, location, shipping) in one batched question.
3. Write title + description in Swedish (sv) and English (en): same facts, natural rewrite, no price/location/shipping in the description. Get the user's OK on the text.
4. Per platform: search_categories, then get_category_fields (search_options for long lists). Use paths and values verbatim; never invent them.
5. create_item (update_item to change it later).
6. One platform at a time: prepare_post, then wait_for_status until it settles.
   - ready_to_publish: show the screenshot and ask for explicit approval. Call publish only on a clear yes, then wait_for_status until posted. Never publish without approval.
   - needs_login: call login(platform), ask the user to log in in the browser window that opens, wait for logged_in, then prepare_post again.
   - failed: report the step and error to the user. Don't retry blindly.`;

# Interface guidelines

These rules apply to every page. A page specification must link here, declare these rules authoritative, and define only its actual elements, layout, action-to-API mapping, page-specific states, and acceptance actions. Resolve a conflict by correcting the page specification before implementation.

## 1. Terms

A clickable element is a `button`, an `a`, or a choice with explicit keyboard behavior. One request action is one user intent and one HTTP request. In progress means sent without a usable response; success requires the contract HTTP status and `ok:true`; failure includes unsuccessful HTTP, `ok:false`, invalid response, network interruption, and local cancellation. Selected means the page adopted the object; a draft exists only in the frontend; the current object's identity remains fixed until its request ends.

## 2. Presentation

`idle` permits one action. `disabled` sets native `disabled`, the disabled visual state, and corresponding ARIA state together, and it blocks mouse, keyboard, and request dispatch. In-progress state names the object and operation, retains content, and blocks resubmission. `selected` sets the `.is-selected` visual state together with the applicable `aria-selected` or `aria-pressed`. Success updates from response data and briefly confirms it; error retains the last successful content and gives a specific reason. Text, color, disabled state, and ARIA change together. Text changes must not move the button. Recovery preserves input, selection, and scroll position.

## 3. Buttons, clicks, and request locks

Use real `button` elements for actions and `a` for navigation. Bind one event entry per action and find it with `event.target.closest('[data-action]')`. Mouse, Enter, and Space share one action and lock; blank button area, label, and icon each trigger it once. A dangerous action opens confirmation first; only its confirm button sends. Cancel, close, back, and overlay clicks send no business write.

Each business-request handler owns an `isSubmitting` boolean. Validate, check the lock, and return immediately when locked. Otherwise set the lock and disable before sending exactly once. On success, update from the response. On backend, timeout, network, parse, or other terminal failure, show the specific error. Every success and failure exit sets `isSubmitting` back to `false` and restores any control that still exists according to the current page state; when navigation removed the control, release the handler lock. The frontend never retries automatically; each explicit retry after completion sends once. Pure UI actions send zero requests. A read, create/update, delete, batch intent, submitted search, or file batch sends one request on success or failure. Typing, deleting, or clearing search does not send, and one batch intent is not split into item requests.

## 4. Selection and order

After validation, update selection and visuals immediately. Keep one `kind:id` and submit the complete collection. `selection_order` is continuous from 0 without gaps, negatives, or duplicates. At a limit, disable add and show the limit. Remove controls name the object or use `aria-label="Remove {name}"`; closing a panel preserves selection.

`kind` is the endpoint-allowed subset of `work`, `character`, `style`; `id` is a safe positive integer; `selection_order` is 0–29. Limits are 5 works, 20 characters, 10 styles, and 30 total. The backend revalidates the complete collection, existence, availability, and type.

## 5. Frontend validation

Store validated user text as its original business value, without HTML entity encoding or decoding. Render plain text with `textContent`; escape every dynamic value for its context in a fixed `innerHTML` template. Enforce contract lengths, using Unicode code points when stated, and Unicode whitespace. Trim search, collapse whitespace, and send nothing for an empty search.

Resource and image IDs are safe positive integers. Validate raw path IDs against `^[1-9][0-9]*$`, then require `Number.isSafeInteger(value)` and the contract maximum after conversion; reject fractions, negatives, empty values, exponents, and extra path segments. Send numeric fields as numbers and reject `NaN`, `Infinity`, floating IDs, and unsafe integers. Request objects contain every required field and no unknown field; send `null` only when allowed, omit `undefined`, and validate every array element. Repositories bind SQLite values; dynamic ordering maps a validated enum to fixed SQL.

## 6. Backend validity

Check in order: method/path, `Content-Type`, JSON parsing, plain object, missing/unknown fields, type/length/enum/range, duplicate/gapped/oversized arrays, path ID, object existence/type/availability, and complete selection. Only then write or call media, vector, or ComfyUI services. Treat path, query, header, cookie, JSON, and multipart values as untrusted.

Validate and explicitly normalize user content without guessing it. Validate range, uniqueness, ownership, relationships, and state for user intent. Derive permission, owner, status, count, `attempt_no`, and timestamps on the server; public writes do not accept them. A server-issued `impact_token` or similar identity may return only for an OpenAPI-defined purpose and must be rechecked for existence, ownership, purpose, and current state; check expiry or single use only when the contract defines it.

## 7. Request and response lifecycle

Before sending, read and validate the current form, then lock and disable as defined in section 3. During the request retain successful content and submitted values locally; disable edits for the same object while unrelated areas remain available; show one loading state. A dialog may close without cancelling a sent business request. On success use one response for entity, list, count, selection, and status, and show success for 2–3 seconds; restore the lock and controls as defined in section 3. Missing required response fields are structural errors. On failure retain successful data and input, remove temporary loading/selection/order, place retry according to `error.code`, and never write guessed titles, order, covers, or lists.

## 8. Common error handling

Codes and messages come from `schema/api/error-catalog.json` and page rules. Every visible error states what happened, the affected field/button/record/file/list, the user's next action, and whether current data remains. Show it in the affected region and put a raw code in optional details. Never show only `Error`, a status code, `undefined`, or blank text.

## 9. Response consistency

JSON is `{"ok":true,"request_id":"...","data":{}}` or `{"ok":false,"request_id":"...","error":{"code":"...","message":"..."}}`. The backend creates `request_id` solely for this HTTP request and log correlation. The frontend neither creates it nor treats it as task identity, a reentry token, or an idempotency key. Validate HTTP status, JSON parsing, Boolean `ok` consistent with status, nonempty `request_id`, and the contracted success `data` or failure `error.code/message`.

## 10. Actionable errors

Put a field error below its field with stable ID, `aria-invalid`, and `aria-describedby`; remove it immediately after correction without clearing input. Item, panel, and permission errors remain until resolved. A network status may hide after 3 seconds while the operation-region error remains; an unknown-system banner may hide after 5 seconds while its log entry remains. Toasts only supplement. On request failure remove loading, restore permitted controls and data, map the code, provide the next-action control, and record operation, object key, and time. `VALIDATION_ERROR` returns to the field; `ITEM_UNAVAILABLE` marks the item and reopens selection; `NOT_FOUND` returns to the list; `WRITE_FORBIDDEN` disables writing; `DATABASE_BUSY` permits a later manual retry; `UPLOAD_TOO_LARGE` and `UPLOAD_TYPE_UNSUPPORTED` name the file and limit; `INTERNAL_ERROR` retains current data and permits a later manual retry.

For batches, list each success and failure; retain successful items and each failure reason, and retry only failed items. Apply the focus behavior in section 12 after every failure. Use `role="alert"` for global error and `role="status"` for ordinary success; update an existing node for repeated errors. Collapsible details may contain code, operation, and client time, never a stack in the main UI.

## 11. Concurrency

Serialize the same action on the same object. Independent handlers may operate on different objects concurrently and update only their bound regions. A late old response must not replace the new current object or list.

## 12. Focus, keyboard, and scroll

After first load focus the first primary action or input. On dialog open focus close or the first control and lock background scroll. Esc closes only the top layer, confirmation first. On close restore the opener focus and previous scroll. Tab visits only visible enabled controls. Preserve search focus after results and scroll after selection. A field-validation failure focuses the first invalid field. Any other request failure focuses the available retry, reload, or original trigger control. An error with no available action control focuses its error region.

## 13. Loading, empty, and failure states

Every data region implements loading, data, empty, and failed views. Loading shows a skeleton or message and disables operations changing the same data. Empty explains the reason and next action. Failure explains it and offers Reload. A local failure replaces only that region. A user Reload sends one GET; further clicks do nothing until completion.

## 14. Uploads

After at least one file is selected, validate media type, per-file size, and batch count against the current `uploads.allowed_media_types`, `uploads.max_file_bytes`, and `uploads.max_files_per_request` values in `config/defaults.json` before listing. Name each invalid file and reason while valid files remain eligible. One click sends one multipart request and disables that batch control. Success refreshes from server image IDs and order; failure retains the gallery and invents no ID. Ordering sends one PUT with complete `image_ids`; cover sends one `image_id` or contract-allowed `null`.

## 15. State hooks

HTML uses `[data-action]` for actions, `data-item`/`data-image-id` for objects, `aria-busy` or a fixed node for loading, `role="alert"`/`aria-describedby` for errors, and `role="status"` for success and progress. Apply the visual, native-attribute, and ARIA synchronization for selected and disabled states from section 2.

## 16. Branch acceptance

Every page directly verifies: empty input sends zero requests; valid input has correct method/path/body/count; double-click yields one request/loading/update; mouse, Enter, and Space yield the same action; failure retains data/input/selection and restores controls; success uses response data; late responses do not overwrite new state; invalid types, out-of-range numbers, unknown fields, and duplicate array values return `422 VALIDATION_ERROR` without writes or upstream calls; permission/not-found/unavailable errors appear correctly; 390×812, 768×1024, and 1440×900 verify focus, scroll, drawers, half-screen panels, and fixed input areas.

## 17. Sources

`schema/api/openapi.yaml` defines HTTP methods, paths, requests, and responses. `schema/api/error-catalog.json` defines errors. `config/defaults.json` defines upload limits. Page-specific files link here and add only page facts. Current implementation and tests prove backend input validation.

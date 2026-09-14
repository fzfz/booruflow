# Normas de interacción de la interfaz

Estas reglas se aplican a todas las páginas. Cada especificación de página debe enlazarlas, declarar su prioridad y definir únicamente elementos reales, disposición, relación entre acciones y API, estados propios y aceptación. Ante un conflicto se corrige la especificación antes de implementar.

## 1. Términos

Un elemento pulsable es `button`, `a` o una opción con teclado explícito. Una acción de solicitud corresponde a una intención y una petición HTTP. En curso significa enviada sin respuesta utilizable; éxito exige estado HTTP contractual y `ok:true`; fallo incluye HTTP no exitoso, `ok:false`, respuesta inválida, interrupción de red y cancelación local. Seleccionado significa adoptado por la página; un borrador solo existe en frontend; la identidad del objeto actual no cambia hasta terminar su petición.

## 2. Presentación

`idle` permite una acción. `disabled` configura a la vez el atributo nativo `disabled`, la presentación visual desactivada y el estado ARIA correspondiente, y bloquea el ratón, el teclado y el envío de solicitudes. El estado en curso identifica el objeto y la operación, conserva el contenido y bloquea la repetición. `selected` configura a la vez la presentación `.is-selected` y el atributo aplicable `aria-selected` o `aria-pressed`. El éxito actualiza con la respuesta y lo confirma brevemente; el error conserva el último contenido correcto y da una causa concreta. El texto, el color, la desactivación y ARIA cambian juntos. El texto no desplaza el botón y la recuperación conserva la entrada, la selección y el desplazamiento.

## 3. Botones, pulsaciones y bloqueo

Usa `button` real para acciones y `a` para navegación. Cada acción tiene una entrada de evento y se identifica con `event.target.closest('[data-action]')`. Ratón, Enter y Space comparten acción y bloqueo; espacio, etiqueta e icono disparan una vez. Una acción peligrosa abre confirmación y solo confirmar envía. Cancelar, cerrar, volver y pulsar el fondo no escriben negocio.

Cada manejador de negocio mantiene su propio `isSubmitting`. Valida, consulta el bloqueo y termina si está activo. Si está libre, activa el bloqueo y deshabilita el control antes de enviar una vez. En caso de éxito actualiza desde la respuesta. Ante un error de backend, tiempo de espera, red, análisis u otra terminación, muestra el error concreto. Todas las salidas de éxito y fallo restauran `isSubmitting` a `false` y restauran según el estado actual cualquier control que siga presente; si la navegación eliminó el control, liberan el bloqueo del manejador. No hay reintento automático; cada reintento explícito tras finalizar envía una vez. Una operación exclusiva de la interfaz envía 0 solicitudes. Una lectura, creación o actualización, borrado, lote, búsqueda confirmada o lote de archivos envía 1 solicitud tanto en éxito como en fallo. Escribir, borrar o vaciar la búsqueda no envía solicitudes y un lote no se divide en solicitudes individuales.

## 4. Selección y orden

Tras validar, actualiza de inmediato colección y aspecto. Conserva un solo `kind:id` y envía la colección completa. `selection_order` empieza en 0, es continuo, no negativo ni repetido. Al alcanzar límite deshabilita añadir y muestra el límite. Quitar nombra el objeto o usa `aria-label="Quitar {nombre}"`; cerrar el panel conserva selección.

`kind` es el subconjunto permitido de `work`, `character`, `style`; `id` es entero positivo seguro; `selection_order` vale 0–29. Límites: 5 obras, 20 personajes, 10 estilos y 30 en total. Backend vuelve a validar colección, existencia, disponibilidad y tipo.

## 5. Validación frontend

Guarda texto validado como valor de negocio original, sin convertir ni revertir entidades HTML. Usa `textContent`; escapa cada valor dinámico según contexto en plantillas fijas con `innerHTML`. Aplica longitudes del contrato, Unicode code points cuando proceda y espacios Unicode. Recorta búsqueda, comprime espacios y no envía búsqueda vacía.

Los ID de recurso e imagen son enteros positivos seguros. Valida el texto original de un ID de ruta con `^[1-9][0-9]*$` y, tras convertirlo, exige `Number.isSafeInteger(value)` y el máximo del contrato; rechaza fracción, negativo, vacío, notación científica o segmentos extra. Envía campos numéricos como números y rechaza `NaN`, `Infinity`, ID flotante o fuera de rango seguro. El objeto contiene todos los campos obligatorios y ninguno desconocido; envía `null` solo si se permite, omite `undefined` y valida cada elemento de array. Repository enlaza parámetros SQLite; orden dinámico transforma un enum validado en SQL fijo.

## 6. Validez backend

Comprueba por orden: método/ruta, `Content-Type`, parseo JSON, objeto simple, campos ausentes/desconocidos, tipo/longitud/enum/rango, arrays repetidos/discontinuos/excesivos, ID de ruta, existencia/tipo/disponibilidad y selección completa. Solo entonces escribe o llama medios, vectores o ComfyUI. Trata path, query, header, cookie, JSON y multipart como entradas no confiables.

Valida y normaliza explícitamente contenido sin adivinarlo. Para intención valida rango, unicidad, propiedad, relaciones y estado. Permiso, owner, estado, cantidad, `attempt_no` y tiempos proceden del servidor y no se aceptan en escritura pública. Un `impact_token` u otra identidad del servidor solo vuelve para el uso definido en OpenAPI y se comprueba de nuevo por existencia, propiedad, finalidad y estado; caducidad o uso único solo si lo define el contrato.

## 7. Ciclo de solicitud y respuesta

Antes de enviar lee y valida el formulario, y después bloquea y deshabilita según la sección 3. Durante la petición conserva el contenido correcto y los valores enviados en variables locales, deshabilita la edición del mismo objeto, mantiene disponibles las áreas independientes y muestra un solo indicador de carga. Cerrar un diálogo no cancela una escritura enviada. En caso de éxito, una respuesta actualiza la entidad, la lista, el conteo, la selección y el texto, y muestra la confirmación durante 2–3 segundos; el bloqueo y los controles se restauran según la sección 3. La ausencia de campos obligatorios es un error estructural. En caso de fallo conserva los datos y las entradas, elimina la carga, selección y orden temporales, sitúa el reintento según `error.code` y mantiene libres de valores inventados los títulos, el orden, las portadas y las listas.

## 8. Errores comunes

Códigos y textos proceden de `schema/api/error-catalog.json` y reglas de página. Cada error explica resultado, campo/botón/registro/archivo/lista afectado, siguiente acción y conservación de datos. Se muestra en su región y el código puede ir en detalle plegable. Nunca se muestra solo `Error`, un estado, `undefined` o vacío.

## 9. Consistencia de respuesta

JSON usa `{"ok":true,"request_id":"...","data":{}}` o `{"ok":false,"request_id":"...","error":{"code":"...","message":"..."}}`. Backend crea `request_id` solo para petición y logs. Frontend no lo crea ni usa como tarea, token de reentrada o clave de idempotencia. Valida estado HTTP, JSON, `ok` booleano coherente, `request_id` no vacío y estructura contractual de `data` o `error.code/message`.

## 10. Errores accionables

El error de campo aparece debajo con ID estable, `aria-invalid` y `aria-describedby`; se quita al corregir sin vaciar. Los errores de elemento, panel y permiso permanecen hasta resolverse. El estado de red puede ocultarse tras 3 segundos mientras el error de la operación permanece; un aviso de sistema desconocido puede ocultarse tras 5 segundos mientras el log permanece. Toast solo complementa. Ante fallo elimina loading, restaura controles permitidos y datos, mapea el código, ofrece siguiente botón y registra operación, clave y hora. `VALIDATION_ERROR` vuelve al campo; `ITEM_UNAVAILABLE` marca y reabre selección; `NOT_FOUND` vuelve a la lista; `WRITE_FORBIDDEN` deshabilita escritura; `DATABASE_BUSY` permite reintento manual posterior; `UPLOAD_TOO_LARGE` y `UPLOAD_TYPE_UNSUPPORTED` nombran archivo y límite; `INTERNAL_ERROR` conserva datos y permite reintento manual posterior.

En los lotes enumera los éxitos y fallos, mantiene los resultados correctos y los motivos, y reintenta solo los elementos fallidos. Después de cada fallo aplica las reglas de foco de la sección 12. Un error global usa `role="alert"` y un éxito normal usa `role="status"`; los errores repetidos actualizan el mismo nodo. El detalle plegable puede mostrar el código, la operación y la hora del cliente, mientras la zona principal permanece libre de la traza de pila.

## 11. Concurrencia

Serializa la misma acción del mismo objeto. Manejadores independientes pueden trabajar sobre objetos distintos y actualizar solo su región. Una respuesta antigua tardía no sustituye el objeto o lista actual.

## 12. Foco, teclado y scroll

Tras la primera carga, enfoca la primera acción o entrada principal. Al abrir un diálogo, enfoca el botón de cierre o el primer control y bloquea el desplazamiento del fondo. Esc cierra solo la capa superior y da prioridad a la confirmación. Al cerrar, restaura el foco del botón de apertura y la posición anterior. Tab visita solo los controles visibles y activos. Conserva el foco de búsqueda tras actualizar los resultados y la posición tras seleccionar. Un error de validación de campos enfoca el primer campo inválido. Cualquier otro fallo de una solicitud enfoca el control disponible para reintentar, recargar o repetir la acción original. Un error sin controles de acción disponibles enfoca su región de error.

## 13. Carga, vacío y fallo

Cada región implementa carga, datos, vacío y fallo. Carga muestra esqueleto o texto y bloquea cambios del mismo dato. Vacío explica causa y siguiente acción. Fallo explica y ofrece Recargar. Un fallo local solo sustituye su región. Una recarga pulsada envía un GET; más pulsaciones no actúan hasta terminar.

## 14. Carga de archivos

Después de seleccionar al menos un archivo, valida el tipo de medio, el tamaño de cada archivo y la cantidad del lote con los valores actuales de `uploads.allowed_media_types`, `uploads.max_file_bytes` y `uploads.max_files_per_request` en `config/defaults.json` antes de mostrar la lista. Nombra cada archivo inválido y su causa, y permite continuar con los válidos. Un clic envía una solicitud multipart y deshabilita el control de ese lote. El éxito actualiza con los ID y el orden devueltos por el servidor; el fallo conserva la galería y no inventa ID. Ordenar envía un PUT con el array `image_ids` completo; la portada usa un `image_id` o el valor `null` permitido por el contrato.

## 15. Ganchos de estado

HTML usa `[data-action]` para la acción, `data-item` o `data-image-id` para el objeto, `aria-busy` o un nodo fijo para la carga, `role="alert"` o `aria-describedby` para el error y `role="status"` para el éxito y el progreso. La presentación, los atributos nativos y ARIA de los estados seleccionado y desactivado siguen la sincronización definida en la sección 2.

## 16. Aceptación de ramas

Cada página verifica: vacío envía 0; válido tiene método/ruta/body/cantidad correctos; doble clic produce una petición/loading/actualización; ratón/Enter/Space producen la misma acción; fallo conserva datos/input/selección y restaura controles; éxito usa respuesta; respuesta tardía no pisa estado nuevo; tipo inválido, número fuera, campo desconocido y array repetido devuelven `422 VALIDATION_ERROR` sin escritura ni llamada externa; permiso/no encontrado/no disponible aparece bien; 390×812, 768×1024 y 1440×900 verifican foco, scroll, cajones, panel medio y entrada fija.

## 17. Fuentes

`schema/api/openapi.yaml` define métodos, rutas, solicitudes y respuestas; `schema/api/error-catalog.json` define errores; `config/defaults.json` define límites de carga. Los documentos de página enlazan aquí y añaden solo hechos propios. La implementación y las pruebas actuales demuestran la validación backend.

# Solución de problemas

Cada punto sigue síntoma, comprobación, acción, éxito y datos para Issue.

- **Node/npm/Git o PATH:** ejecuta sus tres `--version`, instala la versión indicada desde el sitio oficial, abre terminal nueva y repite. `check` correcto confirma. Adjunta SO/CPU, salidas y método.
- **Clone/red:** prueba `git ls-remote https://github.com/fzfz/booruflow.git`, corrige red, proxy o etiqueta y limpia solo el destino incompleto indicado. Checkout correcto confirma. Adjunta URL, etiqueta, salida y estado.
- **Directorio en conflicto:** elige uno vacío o update para BooruFlow existente. El resumen correcto confirma. Adjunta ruta anonimizada y lista.
- **`npm ci`:** comprueba Node, permisos y red; corrige y repite instalador. `check` confirma. Adjunta versiones y error completo.
- **Puerto ocupado:** usa status, detén la instancia o cambia `.env` a puertos libres. Ambos puertos en status confirman. Adjunta puertos y salidas.
- **Configuración incompleta:** completa las seis variables de [Configuración](configuration.md), reinicia y ejecuta check. Adjunta nombres con secretos de ejemplo.
- **Servicio vectorial:** comprueba URL, modelo, autenticación y logs; Embedding debe dar un vector de 1.024 dimensiones por entrada. Reintento correcto confirma. Adjunta fase, tipo, ID y respuesta censurada.
- **Imagen ausente:** compara registro, archivo y permisos de `data/`; añade de nuevo o restaura backup. Miniatura y original confirman. Adjunta ID, página, error y ruta relativa.
- **Update fallido:** conserva parada y backup, corrige el fallo indicado o restaura. Check, inicio y versión confirman. Adjunta versiones, fase y backup ID.
- **Base destino no vacía:** usa una instalación nueva; no borres filas sueltas para eludirlo. `--check` confirma. Adjunta tablas, cantidades y versión.
- **Paquete inválido:** corrige archivo, formato, versión, referencia, medio o ruta y vuelve a exportar desde origen detenido. `--check` 0 confirma. Adjunta formato, objeto, ruta relativa y salida.

Si persiste, sigue [Soporte](../community/support.md) y elige plantilla.

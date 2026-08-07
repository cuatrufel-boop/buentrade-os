# Datos pendientes — no cargados a Supabase todavía

Fuente: `Desktop/DOCS MBG/Pipeline Super X .xlsx` (2026-08-07), ya limpios de filas de prueba/CRM.

- **plants_filtered.csv** (95 empresas): en realidad son **Suppliers** (empresa + contacto), no plantas individuales — no tienen dirección ni planta específica. Pendiente de confirmación del usuario para cargarlos en la tabla `suppliers`.
- **fleteros_filtered.csv** (18 transportistas): son **Freight Carriers** de EE.UU. — esta entidad (mencionada en el documento BUENTRADE Trading OS, sección 3.8) todavía no tiene tabla en la base de datos. Falta crearla antes de cargar esto.

No ejecutar nada de esto hasta que el usuario lo confirme explícitamente.

# Agar.io JMR

Clon personalizado de Agar.io construido con **Node.js + WebSockets nativos** y **Canvas** en el cliente.

## Características

- Movimiento con ratón siguiendo el cursor
- **Dividir** con `Espacio` y **expulsar masa** con `W`
- Virus (células verdes con picos) que dividen a células grandes
- Pellets infinitos
- **Selector de skins** (12 colores)
- **Dos modos de juego**: FFA (todos vs todos) y Equipos (Rojo vs Azul)
- Leaderboard en tiempo real con top 10 + marcador de equipo
- Sistema de fusión de células con cooldown

## Estructura

```
.
├── server.js          # Servidor de juego (WebSockets)
├── package.json
├── railway.json       # Config de despliegue
└── public/
    ├── index.html     # Menú + canvas
    ├── style.css
    └── client.js      # Renderizado y networking
```

## Desarrollo local

```bash
npm install
npm start
```

Abre `http://localhost:3000` en el navegador. Puedes abrir varias pestañas para probar con varios jugadores.

## Despliegue en Railway

1. Crea un repositorio Git con este proyecto y súbelo a GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/agario-jmr.git
   git push -u origin main
   ```

2. Entra a [Railway](https://railway.app) y crea un nuevo proyecto:
   - **New Project → Deploy from GitHub repo**
   - Selecciona el repositorio recién creado

3. Railway detectará automáticamente Node.js. La configuración ya está lista:
   - `package.json` define el script `start`
   - `railway.json` indica `node server.js` como comando de arranque
   - El servidor lee `PORT` desde la variable de entorno (Railway la inyecta)

4. Cuando termine el deploy, abre **Settings → Networking → Generate Domain** para obtener una URL pública.

5. ¡Comparte la URL y a jugar!

### Variables de entorno

- `PORT` — la asigna Railway automáticamente.

## Personalización

Edita `server.js` para ajustar el juego:

| Constante | Descripción |
|---|---|
| `WORLD` | Tamaño del mapa |
| `TICK_RATE` | Tasa de actualización del servidor |
| `PELLET_COUNT` | Cantidad de pellets activos |
| `VIRUS_COUNT` | Cantidad de virus |
| `START_MASS` | Masa inicial al spawnear |
| `MAX_CELLS_PER_PLAYER` | Máximo de células por jugador |
| `MERGE_SECONDS` | Tiempo antes de poder fusionar |
| `SKIN_COLORS` | Colores disponibles |

Para añadir más skins, agrégalos también en `public/client.js` (`SKINS`).

## Licencia

MIT

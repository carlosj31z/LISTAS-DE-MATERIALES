# Instrucciones para Claude Code en este repositorio

## Despliegue a producción

El dominio principal (`https://listas-de-materiales.vercel.app/`) lo sirve
Vercel desde la rama `main` — cualquier otra rama solo genera una URL de
preview (`...-git-<rama>-....vercel.app`).

**El usuario autorizó explícitamente (2026-09-08) fusionar a `main` y hacer
push sin pedir confirmación cada vez**, para que los cambios lleguen al
dominio principal sin fricción. Al terminar un cambio ya probado en la rama
de trabajo:

1. `git checkout -B main origin/main`
2. `git merge --no-ff origin/<rama-de-trabajo>`
3. `git push origin main`
4. Volver a la rama de trabajo designada de la sesión.

Esto reemplaza la regla general de pedir confirmación antes de pushear a una
rama distinta a la designada — pero solo para `main` en este repo, y solo
para llevar trabajo ya terminado y verificado en la rama de trabajo. Sigue
aplicando el resto del protocolo de git (nunca --force, nunca reescribir
historia ajena, revisar el diff antes de comitear).

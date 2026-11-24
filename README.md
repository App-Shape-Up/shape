# Shape

App pessoal de saúde (água, e em breve treinos, dieta, suplementação e hábitos).

- App instalável (PWA) em HTML/CSS/JS puro, publicado pelo GitHub Pages.
- **Sem servidor e sem banco central.** Cada pessoa entra com a própria conta Google e os dados ficam numa planilha "Shape - dados" no Google Drive dela.
- Permissão pedida ao Google: `drive.file` (o app só enxerga os arquivos que ele mesmo criou).
- Funciona sem internet: salva no aparelho e sincroniza com a planilha quando houver conexão.
- Estrutura da planilha: abas `Agua` e `Metas` (definidas em `TABELAS`, no `app.js`) e `Resumo Agua` (fórmula para painéis).
- `config.js` sem `googleClientId` = modo demonstração (dados só no navegador).

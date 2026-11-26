# ShapeUp

App pessoal de saúde (água, e em breve treinos, dieta, suplementação e hábitos).

- App instalável (PWA) em HTML/CSS/JS puro, publicado pelo GitHub Pages.
- **Sem servidor e sem banco central.** Cada pessoa entra com a própria conta Google e os dados ficam numa planilha "Shape - dados" no Google Drive dela.
- Permissão pedida ao Google: `drive.file` (o app só enxerga os arquivos que ele mesmo criou).
- Funciona sem internet: salva no aparelho e sincroniza com a planilha quando houver conexão.
- Estrutura da planilha: abas `Agua`, `Metas`, `Perfil`, `Treinos` e os cadastros (`Cad Treinos`, `Cad Exercicios`, `Cad Alimentos`, `Cad Suplementos`), definidas em `TABELAS` no `app.js`, e `Resumo Agua` (fórmula para painéis).
- Backup: o Perfil envia um .csv com todos os dados para o e-mail da pessoa (permissão `gmail.send`, pedida só na hora do primeiro backup; exige a Gmail API ativada no Google Cloud).
- `config.js` sem `googleClientId` = modo demonstração (dados só no navegador).

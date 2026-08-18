# Valtrix Chat V4.1 — correção de login

Esta versão corrige o fluxo de cadastro/login e inicialização do banco.

Render:
- Build Command: `npm install`
- Start Command: `npm start`

Opcional:
- `JWT_SECRET` = uma chave longa
- `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` para WebRTC/TURN

Depois de substituir os arquivos no GitHub, faça um novo deploy no Render.

Para testar:
1. Abra a URL do Render.
2. Clique em **Criar conta**.
3. Informe usuário com pelo menos 3 caracteres.
4. Senha com pelo menos 6 caracteres.
5. Crie a conta.
6. A aplicação deve entrar automaticamente.

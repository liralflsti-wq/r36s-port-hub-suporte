# Central de suporte do R36S PORT HUB

A interface está em português e usa HTML, CSS e JavaScript. O Supabase Auth gerencia as contas. O PostgreSQL guarda chamados e anexos com acesso restrito ao autor e à administração.

## Ativação

1. Crie um projeto no Supabase. No SQL Editor, execute `setup.sql` uma vez.
2. Em `config.js`, preencha `url` com a Project URL e `publishableKey` com a chave pública `sb_publishable_...`. Mantenha chaves secretas e credenciais administrativas fora do repositório.
3. Em **Settings → Pages**, escolha **Deploy from a branch**, branch **main**, pasta **/(root)**. Confira a URL publicada. A URL esperada caso o repositório use o domínio padrão é `https://liralflsti-wq.github.io/r36s-port-hub-suporte/`.
4. Em **Supabase → Authentication → URL Configuration**, use o endereço publicado como **Site URL** e adicione o mesmo endereço em **Redirect URLs**. Em **Providers**, habilite e-mail. Configure um provedor SMTP próprio para entregar e-mails de confirmação e recuperação ao público.
5. Crie e confirme a conta que será administradora. Copie seu UUID em **Authentication → Users** e execute no SQL Editor:

   ```sql
   insert into public.support_admins (user_id)
   values ('UUID_DA_CONTA')
   on conflict do nothing;
   ```

## Fluxo

- 0% mostra **Recebido**. De 1% a 99% mostra **Em correção**. 100% mostra **Resolvido**.
- O painel da administração permite atualizar a porcentagem e a nota de correção.
- Cada chamado aceita um anexo privado de até 4 MB, baixado sob demanda.
- Confirme o fluxo com duas contas comuns e uma administradora. Abra um chamado com anexo, verifique que a segunda conta comum não consegue consultá-lo, salve atualizações como administradora e confira o resultado na conta que abriu o chamado. Teste cadastro por e-mail e recuperação de senha após configurar os provedores.

[Documentação do GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

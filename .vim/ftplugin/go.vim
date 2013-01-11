setlocal noexpandtab
nmap <Leader><Leader> :w<CR>:!cd %:p:h && go test<CR>

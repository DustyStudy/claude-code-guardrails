import { expect, test } from 'claude-code/testing'

import { invocations, namedByShell } from './shell'

const CASES: readonly (readonly [string, boolean])[] = [
  ['terraform apply -auto-approve', false],
  ['terraform destroy -auto-approve', false],
  // xargs and parallel add words from their input; source and . run piped input as a script.
  ["printf 'apply -auto-approve' | xargs terraform", false],
  ["echo apply -auto-approve | xargs -n2 /usr/bin/terraform", false],
  ["echo apply -auto-approve | sudo xargs terraform", false],
  ["echo -auto-approve | parallel terraform apply", false],
  ["echo 'terraform apply -auto-approve' | source /dev/stdin", false],
  ["echo 'terraform apply -auto-approve' | . /dev/stdin", false],
  ['ls *.log | xargs wc -l', true],
  ["echo 'terraform plan' | grep -c .", true],
  // Found in review: xargs inside a script, source after builtin or command, and a pipe that goes on past |& or a line end.
  ["printf 'apply -auto-approve' | xargs sh -c 'terraform \"$@\"' sh", false],
  ["printf 'terraform apply -auto-approve' | builtin source /dev/stdin", false],
  ["printf 'terraform apply -auto-approve' | command source /dev/stdin", false],
  ["printf 'terraform apply -auto-approve' | command -- source /dev/stdin", false],
  ["printf 'terraform apply -auto-approve' | builtin -- . /dev/stdin", false],
  ["printf 'apply -auto-approve' | sh -c 'x\"\"args terraform'", false],
  // Found in the 1174367 review: a string xargs -I replaces is the input's, the verb or the program too; source reads a heredoc
  // or here-string, after eval too.
  ['echo apply | xargs -Iplan terraform plan -auto-approve', false],
  ['echo apply | xargs -I plan terraform plan -auto-approve', false],
  ['echo apply | xargs -0rIplan terraform plan -auto-approve', false],
  ['echo apply | xargs --max-args 1 -Iplan terraform plan -auto-approve', false],
  ['echo apply | xargs --replace=plan terraform plan -auto-approve', false],
  ['echo apply | xargs -J plan terraform plan -auto-approve', false],
  ['echo terraform | xargs -IX X apply -auto-approve', false],
  ['ls | parallel terraform {} -auto-approve', false],
  ["source /dev/stdin <<'EOF'\nterraform apply -auto-approve\nEOF", false],
  ["source /dev/stdin <<< 'terraform apply -auto-approve'", false],
  [". /dev/stdin <<< 'terraform apply -auto-approve'", false],
  ["echo 'terraform apply -auto-approve' | eval source /dev/stdin", false],
  ["echo 'terraform apply -auto-approve' | (source /dev/stdin)", false],
  ["echo 'terraform apply -auto-approve' | { source /dev/stdin; }", false],
  // Found in review of the first try: parallel's own replace options, a replace string set in a wrapper's script, a
  // redirection or here-string before source, a quoted source name; a . that is only an argument reads no heredoc.
  ['parallel --replace plan terraform plan -auto-approve ::: apply', false],
  ['parallel -i plan terraform plan -auto-approve ::: apply', false],
  ['parallel --extensionreplace plan terraform plan -auto-approve ::: apply', false],
  ['echo apply | sh -c \'xargs -Iplan "$@"\' sh terraform plan -auto-approve', false],
  ["2> /dev/null source /dev/stdin <<< 'terraform apply -auto-approve'", false],
  ["<<< 'terraform apply -auto-approve' source /dev/stdin", false],
  ['sou""rce /dev/stdin <<EOF\nterraform apply -auto-approve\nEOF', false],
  ['FOO=1 . /dev/stdin <<EOF\nterraform apply -auto-approve\nEOF', false],
  ['cp x . <<EOF\nterraform apply -auto-approve\nEOF', true],
  ['echo apply | sh -c \'xargs -Iplan "$@"\' xargs terraform plan -auto-approve', false],
  ['command -- . /dev/stdin <<EOF\nterraform apply -auto-approve\nEOF', false],
  ['cat > source <<EOF\nterraform apply -auto-approve\nEOF', true],
  ["find . -name '*.tf' | xargs -I{} terraform fmt {}", true],
  ['source .venv/bin/activate && terraform plan', true],
  ["printf 'terraform apply -auto-approve' |& source /dev/stdin", false],
  ["printf 'terraform apply -auto-approve' |\nsource /dev/stdin", false],
  ["printf 'terraform apply -auto-approve' |& bash", false],
  ["printf 'terraform apply -auto-approve' |\n  bash", false],
  ['terraform plan -no-color |\n  tee plan.log', true],
  ['make fmt || source .venv/bin/activate', true],
  // The rest of a heredoc's opening line is a command too.
  ['cat <<EOF | terraform apply -auto-approve\nyes\nEOF', false],
  // A here-string is no heredoc; an unquoted heredoc runs its substitutions; one piped to a later shell is its script.
  ['cat <<<EOF\nterraform apply -auto-approve\nEOF', false],
  ['cat <<EOF\n$(terraform apply -auto-approve)\nEOF', false],
  ["cat <<'EOF' |\nterraform apply -auto-approve\nEOF\nsh", false],
  ["cat <<'EOF'\n$(terraform apply -auto-approve)\nEOF", true],
  ["cat <<EOF\n$(terraform apply $(printf -- '-auto-approve'))\nEOF", false],
  ["cat <<'EOF' |\nterraform apply -auto-approve\nEOF\nenv sh", false],
  // A << in quotes or a comment starts no heredoc, and a tag that goes on past its quote is not one the end line matches.
  ["echo '<<EOF'\nterraform apply -auto-approve\nEOF", false],
  ['# <<EOF\nterraform apply -auto-approve\nEOF', false],
  ['cat <<"EO"F\nEOF\nterraform apply -auto-approve\nEO', false],
  ['cat <<EOF > notes.md\nterraform apply -auto-approve\nEOF', true],
  // bash drops a backslash in a name and expands a brace list; a comment ends at its line, a trailing \ or not.
  [String.raw`\terraform apply -auto-approve`, false],
  [String.raw`terr\aform apply -auto-approve`, false],
  ['{terraform,apply,-auto-approve}', false],
  ['echo done # \\\nterraform apply -auto-approve', false],
  // Programs that run the command after them.
  ['coproc terraform apply -auto-approve', false],
  ["trap 'terraform apply -auto-approve' EXIT", false],
  ['aws-vault exec prod -- terraform apply -auto-approve', false],
  ['op run -- terraform apply -auto-approve', false],
  ['su -c "terraform apply -auto-approve"', false],
  ['su --command="terraform apply -auto-approve"', false],
  [String.raw`s\udo terraform apply -auto-approve`, false],
  ['echo $((1<<2))\nterraform apply -auto-approve\n2', false],
  ['echo ok;# <<EOF\nterraform apply -auto-approve\nEOF', false],
  ['cd infra && terraform -chdir=stack apply --auto-approve tfplan', false],
  ['AWS_PROFILE=security terraform apply', false],
  ['terraform apply -var-file prod.tfvars', false],
  ['terragrunt run-all apply -auto-approve', false],
  ['terraform plan -out=tfplan', true],
  ['terraform plan -destroy -out=tfplan', true],
  ['terraform apply tfplan', true],
  ['terraform apply -parallelism=1 "gd.tfplan"', true],
  ['terraform fmt -recursive; terraform validate', true],
  ['git status', true],
  ['terraform apply 2>& 1', false],
  ["find . -name '*.tf' -exec terraform apply -auto-approve {} \\;", false],
  ["find . -name '*.tf' -exec terraform fmt {} \\;", true],
  ['ls *.tf | xargs -I{} terraform validate {}', true],
  ['terraform fmt {main,iam}.tf', true],
  ['terraform apply ${PLAN:-tfplan}', true],
  ["$tags = @{ Name = 'x' }; terraform plan -out=tfplan", true],
  ['Get-ChildItem | ForEach-Object { terraform apply -auto-approve }', false],
  ['Get-ChildItem | ForEach-Object {terraform destroy -auto-approve}', false],
  ['terraform apply 2>&1', false],
  ['terraform apply > apply.log', false],
  ['terra\\\nform apply -auto-approve', false],
  ['terraform apply \\\n  -auto-approve tfplan', false],
  ['terraform apply tfplan${SUFFIX} -auto-approve', false],
  ['terraform apply ${PLAN} 2>&1 | tee apply.log', true],
  ['Get-ChildItem | ForEach-Object { terraform fmt $_.FullName }', true],
  ['terraform -chdir=terraform/scanner apply -parallelism=1 tfplan 2>&1 | tee apply.log', true],
  ['(terraform apply -auto-approve)', false],
  ['echo $(terraform apply -auto-approve)', false],
  ['echo "$(terraform destroy -auto-approve)"', false],
  ['echo `terraform apply -auto-approve`', false],
  ['if true; then terraform apply -auto-approve; fi', false],
  ['{ terraform apply -auto-approve; }', false],
  ['! terraform apply -auto-approve', false],
  ['>/dev/null terraform apply -auto-approve', false],
  ['> /dev/null terraform apply -auto-approve', false],
  ['terraform apply "gd;plan.tfplan" -auto-approve', false],
  ['terraform apply tfplan `\n  -auto-approve', false],
  ["Start-Process terraform -ArgumentList 'apply -auto-approve'", false],
  ['Invoke-Expression "terraform apply -auto-approve"', false],
  ['sudo env TF_LOG=1 terraform destroy -auto-approve', false],
  // More wrappers, some with options before the program, and PowerShell's and bash's own quoting of a name.
  ['nice terraform apply -auto-approve', false],
  ['ionice -c3 terraform apply -auto-approve', false],
  ['stdbuf -oL terraform apply -auto-approve', false],
  ['doas terraform apply -auto-approve', false],
  ['watch terraform apply -auto-approve', false],
  ['parallel terraform ::: apply -auto-approve', false],
  ['busybox sh -c "terraform apply -auto-approve"', false],
  ['dash -c "terraform apply -auto-approve"', false],
  ['ksh -c "terraform apply -auto-approve"', false],
  ['fish -c "terraform apply -auto-approve"', false],
  ['chroot / terraform apply -auto-approve', false],
  ['setsid terraform apply -auto-approve', false],
  ['unbuffer terraform apply -auto-approve', false],
  ["script -c 'terraform apply -auto-approve' /dev/null", false],
  ['flock /tmp/tf.lock terraform apply -auto-approve', false],
  ['firejail terraform apply -auto-approve', false],
  ['systemd-run terraform apply -auto-approve', false],
  ['terraf`orm apply -auto-approve', false],
  ['te`rraform apply -auto-approve', false],
  ["$'terraform' apply -auto-approve", false],
  ['echo `terraform plan -out=tfplan`', true],
  ["$env:AWS_PROFILE='security'; terraform plan -out=tfplan", true],
  ['terraform apply tfplan 2>&1 | tee apply.log', true],
  ['echo "example; terraform apply -auto-approve; example"', true],
  ["bash -c 'echo terraform apply -auto-approve'", true],
  ['terraform destroy -auto-approve=1', false],
  ['terraform apply -auto-approve=TRUE tfplan', false],
  ['terraform apply -auto-approve=false tfplan', true],
  ['& "C:\\Program Files\\Terraform\\terraform.exe" apply -auto-approve', false],
  ['bash -c "terraform apply -auto-approve"', false],
  ['& terraform apply', false],
  ['echo "never run terraform apply -auto-approve"', true],
  ['git commit -m "docs: explain terraform apply"', true],
  ["node task.mjs <<'EOF'\nReview the guard.\nterraform apply -auto-approve is denied.\nEOF", true],
  ["cat > notes.md <<EOF\nterraform apply\nEOF\nterraform destroy -auto-approve", false],
  // A comment is not a plan file, and a full path does not hide a wrapper.
  ['terraform apply # deploy', false],
  ['terraform apply tfplan # reviewed', true],
  ['terraform apply # tfplan\nterraform plan -out=tfplan', false],
  ['/bin/bash -c "terraform apply -auto-approve"', false],
  ['/usr/bin/env TF_LOG=1 terraform destroy -auto-approve', false],
  // apply as another subcommand's value, and help, change nothing.
  ['terraform output apply', true],
  ['terraform state show destroy', true],
  ['terraform apply -help', true],
  ['terraform -chdir=stack apply', false],
  // Flags passed through Terraform's environment, and a script a shell reads from a heredoc.
  ['TF_CLI_ARGS_destroy=-auto-approve terraform destroy', false],
  ["$env:TF_CLI_ARGS_destroy='-auto-approve'; terraform destroy", false],
  ["bash <<'EOF'\nterraform destroy -auto-approve\nEOF", false],
  ['cat <<EOF | sh\nterraform apply -auto-approve\nEOF', false],
  ['"/bin/bash" <<EOF\nterraform destroy -auto-approve\nEOF', false],
  ["cat > install.sh <<'EOF' # bash script\nterraform destroy -auto-approve\nEOF", true],
  ["TF_CLI_ARGS='-auto-approve=false' terraform apply tfplan", true],
  // Terragrunt approves by itself when it runs every unit, and its flags' values are not plan files.
  ['terragrunt run-all destroy --terragrunt-non-interactive', false],
  ['terragrunt run --all destroy', false],
  ['terragrunt destroy --all --non-interactive', false],
  ['terragrunt destroy-all', false],
  ['terragrunt apply-all', false],
  ['terragrunt graph destroy', false],
  ['terragrunt run-all apply --terragrunt-working-dir live/prod', false],
  ['terragrunt --working-dir modules apply -auto-approve', false],
  ['tofu apply -exclude aws_instance.x', false],
  ['terragrunt run-all apply tfplan', true],
  ['terragrunt run-all apply --terragrunt-working-dir live/prod tfplan', true],
  ['terragrunt run-all plan -out=tfplan', true],
  ['terragrunt run-all destroy --terragrunt-no-auto-approve', true],
  ['terraform apply -no-color -input=false tfplan', true],
  ['terraform graph -type=apply', true],
  ['terraform destroy -var-file stack', true],
  ['terraform apply -lock-timeout 60s tfplan', true],
  // An approval fed to destroy is -auto-approve by another name; so is the flag set in the environment any other way.
  ['echo yes | terraform destroy', false],
  ["f() { true | cat; terraform destroy; }; printf 'yes\\n' | f", false],
  ["function f { true | cat; terraform destroy; }; printf 'yes\\n' | f", false],
  ["printf 'yes\\n' | (true | cat; terraform destroy)", false],
  ["printf 'yes\\n' | { true | cat; terraform destroy; }", false],
  ["'yes' | terraform destroy -target=aws_instance.x", false],
  ['yes | (cd stack && terraform destroy)', false],
  ['terraform destroy <<< yes', false],
  ['terraform destroy < yes.txt', false],
  ['terraform destroy', true],
  ['terraform destroy 2>&1 | tee destroy.log', true],
  ["[Environment]::SetEnvironmentVariable('TF_CLI_ARGS_destroy', '-auto-approve'); terraform destroy", false],
  ['$env:TF_CLI_ARGS_destroy += " -auto-approve"; terraform destroy', false],
  // A quoted TF_CLI_ARGS value is read whole: a & | or ; inside the quotes does not end it.
  ["TF_CLI_ARGS_destroy='-var=a=b&c -auto-approve' terraform destroy", false],
  ['TF_CLI_ARGS="-var=a=b|c -auto-approve" terraform apply tfplan', false],
  ["TF_CLI_ARGS_apply='-var=a=b;c -auto-approve' terraform apply tfplan", false],
  ["TF_CLI_ARGS_plan='-var=a=b&c' terraform apply tfplan", true],
  ["TF_CLI_ARGS='-no-color' terraform apply tfplan; echo -auto-approve", true],
  // Shell builtins and package runners that run the program named after them, and the Windows names of the programs.
  ['builtin terraform destroy -auto-approve', false],
  ['noglob terraform destroy -auto-approve', false],
  ['command terraform destroy -auto-approve', false],
  ['exec terraform destroy -auto-approve', false],
  ['time terraform apply -auto-approve', false],
  ['nohup terraform apply -auto-approve', false],
  ['timeout 60 terraform apply -auto-approve', false],
  ['ls | xargs terraform apply -auto-approve', false],
  ['terraform.cmd destroy -auto-approve', false],
  ['terraform.exe destroy -auto-approve', false],
  ['tofu.cmd apply', false],
  ['tofu.exe apply -auto-approve tfplan', false],
  ['terragrunt.exe destroy -auto-approve', false],
  ['terragrunt.cmd run-all destroy', false],
  ['npx terraform destroy -auto-approve', false],
  ['npx -y terraform apply', false],
  ['npx -c "terraform destroy -auto-approve"', false],
  ['bunx terraform apply', false],
  ['pnpm dlx terraform destroy -auto-approve', false],
  ['yarn dlx tofu apply -auto-approve', false],
  ['uvx terragrunt.cmd destroy -auto-approve', false],
  ['sudo npx terraform apply -auto-approve tfplan', false],
  ['npx terraform plan -out=tfplan', true],
  ['npx terraform apply tfplan', true],
  ['terraform.cmd apply tfplan', true],
  ['pnpm dlx cdktf apply', true],
  ['npx cowsay destroy -auto-approve', true],
  ['yarn add terraform', true],
  // A pipe before a destroy feeds it wherever the destroy sits in the pipeline's last command.
  ['yes |\nterraform destroy', false],
  ['yes | while true; do terraform destroy; done', false],
  ['yes | bash -c "cd stack; terraform destroy"', false],
  // A pipe that ends at a plain command and a ; before the destroy does not feed it; anything less plain after the pipe still counts.
  ['terraform plan | tee plan.txt; terraform destroy', true],
  ['git log | head; terraform destroy', true],
  ['git log | head\nterraform destroy', true],
  ['terraform plan >| plan.log; terraform destroy', true],
  ['echo yes | terraform destroy; echo done', false],
  ['git log | head; yes | terraform destroy', false],
  ['yes | tee log | terraform destroy', false],
  ['yes | sudo terraform destroy; echo done', false],
  ['yes | env TF_LOG=1 terraform destroy; echo done', false],
  ['yes | while read x; do terraform destroy; done', false],
  ['yes | until false; do terraform destroy; done', false],
  ['yes | for i in 1; do terraform destroy; done', false],
  ['yes | if true; then terraform destroy; fi', false],
  ['yes | { cd stack; terraform destroy; }', false],
  ['yes | time -p; terraform destroy', false],
  ['yes | cat \\\n; terraform destroy', false],
  ['yes | cat "a;b"; yes | terraform destroy', false],
  ['yes |& terraform destroy', false],
  ['yes | cd stack && terraform destroy', false],
  ['yes | terraform apply', false],
  ['"yes" | ForEach-Object { $_ }; "yes" | terraform destroy', false],
  // A substitution among the arguments can add the flag or the verb; one in another subcommand's arguments changes nothing.
  ['terraform $(echo destroy -auto-approve)', false],
  ['terraform apply $(cat plan-name)', false],
  ['terraform -chdir=$(pwd) apply tfplan', false],
  ['terragrunt run-all $(echo destroy)', false],
  ['terraform plan -out=$(date +%F).tfplan', true],
  // A substitution before the subcommand can be the subcommand and its flags; quoted as a flag's value it is one word.
  ['terraform -chdir=$(pwd) validate', false],
  ['terraform -chdir="$(pwd)" validate', true],
  ['terraform $(echo destroy -auto-approve -backup) plan', false],
  ['terraform "$(echo destroy)" -auto-approve -backup plan', false],
  ['terraform -chdir=${x:-"}"$(echo x destroy -auto-approve -var a=)"}" -backup plan', false],
  ['sudo terraform -chdir="$(pwd)" plan -out="$(date +%F).tfplan"', true],
  ['sudo $(echo -n) terraform apply tfplan', false],
  ['npx $(echo -y) terraform apply tfplan', false],
  ['terragrunt run-all $(echo destroy --terragrunt-non-interactive --x) plan', false],
  ['terraform destroy -auto-approve $(echo --) -help', false],
  ['terragrunt run-all plan -out=$(date +%F).tfplan', true],
  // A function fed by a pipe takes the approval for the destroy in it.
  ['f() { terraform destroy; }; yes | f', false],
  ['function f { terraform destroy; }; echo yes | f', false],
  // A word the shell fills in before the program, under a wrapper or as the program, can add arguments or another subcommand.
  ['sudo $(echo -n) terraform plan', false],
  ['env $(echo TF_CLI_ARGS=-auto-approve) terraform apply tfplan', false],
  ['env $FLAGS terraform apply tfplan', false],
  ['$(echo sudo) terraform plan', false],
  ['sudo env TF_LOG=1 terraform plan', true],
  // A program named by a variable, a substitution or an alias, with apply or destroy and -auto-approve.
  ['TF=terraform; $TF destroy -auto-approve', false],
  ['${TF} apply -auto-approve', false],
  ['$env:TF destroy -auto-approve', false],
  ['"$TF" destroy -auto-approve', false],
  ['sudo $TF destroy -auto-approve', false],
  ['$(which terraform) destroy -auto-approve', false],
  ['alias tf=terraform; tf destroy -auto-approve', false],
  ["alias tf='terraform destroy -auto-approve'; tf", false],
  ['Set-Alias tf terraform; tf destroy -auto-approve', false],
  // A program the shell names gets every check a written one does.
  ['TF_CLI_ARGS=-auto-approve $TF destroy', false],
  ['yes | $TF destroy', false],
  ['$TF destroy $(echo -auto-approve)', false],
  ['$TG run-all destroy', false],
  ['$TF apply', false],
  ['$TF.exe destroy -auto-approve', false],
  ['$T$F destroy -auto-approve', false],
  ['sal tf terraform; tf destroy -auto-approve', false],
  ['nal tf terraform; tf destroy -auto-approve', false],
  ['Set-Alias -Value terraform -Name tf; tf destroy -auto-approve', false],
  ['alias -- tf=terraform; tf destroy -auto-approve', false],
  ['tf() { terraform "$@"; }; tf destroy -auto-approve', false],
  ['function tf { terraform $args }; tf destroy -auto-approve', false],
  ['noglob env $FLAGS terraform apply tfplan', false],
  ['env TF_CLI_ARGS$A terraform apply tfplan', false],
  ['$TF apply tfplan', true],
  ['tf() { terraform "$@"; }; tf plan', true],
  ['$TF plan', true],
  ['alias tf=terraform; tf plan', true],
  ['$out = terraform plan -out=tfplan', true],
  // Routine commands.
  ['terraform plan', true],
  ['terraform fmt', true],
  ['terraform validate', true],
  ['terraform init', true],
  ['terraform output', true],
  ['terraform state list', true],
  ['terraform apply plan.tfplan', true],
  ['terraform -chdir=x apply plan.tfplan', true],
]

// Forms only the shared parser (shell.ts) can read: each is denied once the parser reads it as the shell does.
const PARSER_CASES: readonly (readonly [string, boolean])[] = [
  // Found by the 0.8 audit. Only -h, -help and --help are help, and not after --.
  ['terraform destroy -auto-approve -backup --h', false],
  ['terraform destroy -auto-approve -- -h', false],
  ['terraform destroy -auto-approve --help', true],
  // TF_CLI_ARGS is read as the shell hands it on: escapes and quotes gone, and a value the shell fills in is not trusted.
  [String.raw`TF_CLI_ARGS=-auto-appr\ove terraform destroy`, false],
  ['TF_CLI_ARGS=-auto-"approve" terraform destroy', false],
  ["TF_CLI_ARGS=-auto-appr''ove terraform destroy", false],
  ['TF_CLI_ARGS=-auto-\\\napprove terraform destroy', false],
  [String.raw`TF_CLI_ARGS=-no-color\;\ -auto-approve terraform destroy`, false],
  ['TF_CLI_ARGS=$FLAGS terraform destroy', false],
  [String.raw`TF_CLI_ARGS=$'\x2dauto-approve' terraform destroy`, false],
  ['env TF_CLI_ARGS=-auto-{,approve} terraform destroy', false],
  ['$env:TF_CLI_ARGS = "-auto-appr`ove"; terraform destroy', false],
  ['TF_CLI_ARGS=-no-color terraform apply tfplan', true],
  // bash's $'...' decodes its escapes, and a \' inside it does not close it.
  [String.raw`terraform destroy $'\x2dauto-approve'`, false],
  [String.raw`terraform destroy $'\055auto-approve'`, false],
  [String.raw`terraform destroy $'-auto-approve'`, false],
  [String.raw`$'\x74erraform' destroy -auto-approve`, false],
  [String.raw`echo $'\'' ; terraform destroy -auto-approve #'`, false],
  [String.raw`echo $'it\'s done'; terraform plan`, true],
  [String.raw`echo $'a\'"'; terraform destroy -auto-approve ; echo "`, false],
  // A case pattern's ) would end a $( ) early: the line is refused, not read.
  ['echo "$(case x in a) terraform destroy -auto-approve ;; esac)"', false],
  ['echo $(case x in a) terraform destroy -auto-approve ;; esac)', false],
  ['echo "$(echo in case of fire)"', true],
  // $$ is the shell's id and the quote after it a plain one; a shell without $'...' reads plain quotes throughout.
  [String.raw`echo $$'a\'; terraform destroy -auto-approve; echo 'b'`, false],
  [String.raw`echo $$'a\' $'\'' ; terraform destroy -auto-approve #'`, false],
  [String.raw`echo $'\'' $$'a\' $'\'' ; terraform destroy -auto-approve #'`, false],
  [String.raw`sh -c "echo $'a\'; terraform destroy -auto-approve; echo 'b'"`, false],
  // A brace sequence, and a list that holds a brace pair bash leaves as written.
  ['terraform destroy -auto-approv{e..e}', false],
  ['terraform destroy {-auto-approve,-var={x}}', false],
  ['terraform destroy -auto-approve -var={x}', false],
  ['terraform fmt main{1..3}.tf', true],
  ["find . -name '*.tf' -exec terraform destroy -auto-approve \\;", false],
  ['find . -maxdepth 0 -exec terraform destroy -auto-approve \\;', false],
  ['find . -maxdepth 0 -execdir terraform destroy -auto-approve {} +', false],
  // What follows the ; or + that ends -exec is find's, not Terraform's: a -help there is no help.
  ['find . -maxdepth 0 -exec terraform destroy -auto-approve \\; -name -help', false],
  ['find . -maxdepth 0 -exec terraform destroy -auto-approve {} + -name -h', false],
  // >| and &> are redirections: the words after them are still the program's.
  ['terraform apply tfplan >|out -auto-approve', false],
  ['terraform apply tfplan >| out -auto-approve', false],
  ['terraform destroy >|out -auto-approve', false],
  ['terraform apply tfplan &>out -auto-approve', false],
  ['terraform apply tfplan &>> out -auto-approve', false],
  [String.raw`echo \>|terraform destroy -auto-approve`, false],
  [String.raw`echo \>&terraform destroy -auto-approve`, false],
  ['terraform plan -out=tfplan >| plan.log', true],
  ['terraform apply tfplan &> apply.log', true],
  [String.raw`terraform destroy -auto-appr\ove`, false],
  [String.raw`terraform destr\oy -auto-approve`, false],
  ['terraform destroy -{auto-approve,no-color}', false],
  ['terraform {destroy,-auto-approve}', false],
  ['$out = terraform destroy -auto-approve', false],
  ['. terraform destroy -auto-approve', false],
  ['terraform apply <# x #> -auto-approve', false],
  [String.raw`bash -c "bash -c \"terraform destroy -auto-approve\""`, false],
  ["terraform destroy ('-auto-approve')", false],
  ['terraform destroy `-auto-approve`', false],
  ['terraform destroy $(echo -auto-approve)', false],
  ['echo "terraform destroy -auto-approve" | bash', false],
  ['cmd /c terraform destroy -auto-appr^ove', false],
  // A ${ } ends where bash ends it: a quoted or nested } inside does not, and a # inside is no comment.
  ['echo ${x:-"}"}; terraform destroy -auto-approve; echo "x"', false],
  ["echo ${x:-'}'}; terraform destroy -auto-approve; echo 'x'", false],
  ['echo ${a:-${b} #}; terraform destroy -auto-approve', false],
  ['echo ${x:-$(echo })}; terraform destroy -auto-approve', false],
  // A ' inside a ${ } inside double quotes quotes or not by bash version: refused, not guessed. One never closed is refused too.
  ["echo \"${x:-'}'}\"; terraform plan", false],
  ['echo ${x:-; terraform plan', false],
  ['terraform apply "${PLAN:-${DEFAULT}}"', true],
  ['echo "${x:-"a b"}"; terraform plan', true],
]

test('namedByShell gives the arguments of a program the shell names', () => {
  expect(namedByShell('$NPM install x')).toEqual([['install', 'x']])
  expect(namedByShell('sudo ${NPM} install x')).toEqual([['install', 'x']])
  expect(namedByShell('$(echo npm) install x')).toContainEqual(['install', 'x'])
  expect(namedByShell('npm install x')).toEqual([])
  expect(namedByShell('$out = npm install x')).toEqual([])
  // The classic contract is unchanged: the variable is passed over and the next word is the program.
  expect(invocations('$NPM install x', /^install$/)).toEqual([['x']])
})

test('an -auto-approve inherited through TF_CLI_ARGS_destroy is denied', async ($, on) => {
  on('env.get', (_, e) => ({ value: e.name === 'TF_CLI_ARGS_destroy' ? '-auto-approve' : undefined }))
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  expect((await $.tool.call({ tool: 'Bash', command: 'terraform destroy' })).deny).toMatch(/auto-approve is not allowed/)
  // TF_CLI_ARGS_destroy is destroy's alone.
  expect((await $.tool.call({ tool: 'Bash', command: 'terraform apply tfplan' })).deny).toBeUndefined()
})

test('a quoted -auto-approve inherited through TF_CLI_ARGS is denied', async ($, on) => {
  on('env.get', (_, e) => ({ value: e.name === 'TF_CLI_ARGS' ? '-no-color "-auto-approve"' : undefined }))
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  expect((await $.tool.call({ tool: 'Bash', command: 'terraform apply tfplan' })).deny).toMatch(/auto-approve is not allowed/)
})

for (const tool of ['Bash', 'PowerShell'] as const) {
  for (const [command, isAllowed] of [...CASES, ...PARSER_CASES]) {
    test(`${tool} ${isAllowed ? 'runs' : 'is denied'}: ${command}`, async ($, on) => {
      let hasRun = false

      on('env.get', () => ({ value: undefined }))
      on('tool.call', { tool: [tool] }, () => {
        hasRun = true

        return { result: { stdout: '', stderr: '', interrupted: false } }
      })

      const ran = await $.tool.call({ tool, command })

      expect(hasRun).toBe(isAllowed)
      // A guard that threw also stops the call: that is not the policy denying it.
      expect(/guard failed/.test(JSON.stringify(ran))).toBe(false)
    })
  }
}

// Monitor and the desktop app's terminal tool hand a command line to a shell too: they are checked like Bash.
for (const tool of ['Monitor', 'mcp__terminal__run_in_terminal']) {
  test(`${tool} is denied what Bash is, and runs the rest`, async ($, on) => {
    on('env.get', () => ({ value: undefined }))
    const ran: string[] = []

    on('tool.call', { tool: [tool] }, (_, e) => {
      ran.push(String(e.command))

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const denied = JSON.stringify(await $.tool.call({ tool, command: 'terraform destroy -auto-approve' } as never))
    await $.tool.call({ tool, command: 'git status' } as never)
    // A Monitor that opens a WebSocket has no command.
    await $.tool.call({ tool, ws: { url: 'wss://example.com/events' } } as never)

    expect(ran).toEqual(['git status', 'undefined'])
    expect(denied).toContain('terraform-guard: ')
    expect(denied).not.toContain('guard failed')
  })
}

test("a subagent's call is denied like the main loop's", async ($, on) => {
  on('env.get', () => ({ value: undefined }))
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  expect((await $.tool.call({ tool: 'Bash', command: 'terraform destroy -auto-approve', agentId: 'a1' })).deny).toMatch(/auto-approve is not allowed/)
})

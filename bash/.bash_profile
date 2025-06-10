# shellcheck disable=all

# .bash_profile is executed for login shells.

# Source local configs that we may have preempted, see ./scripts/backup_local_dotfiles.bash
source ~/.bash_profile.local 2>/dev/null || source ~/.bash_login.local 2>/dev/null || source ~/.profile.local 2>/dev/null || :

# Source
source ~/.bashrc
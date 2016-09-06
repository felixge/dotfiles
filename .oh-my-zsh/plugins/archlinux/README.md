# Archlinux plugin

## Features

#### YAOURT

| Alias   | Command                            | Description                                                         |
|---------|------------------------------------|---------------------------------------------------------------------|
| yaconf  | yaourt -C                          | Fix all configuration files with vimdiff                            |
| yain    | yaourt -S                          | Install packages from the repositories                              |
| yains   | yaourt -U                          | Install a package from a local file                                 |
| yainsd  | yaourt -S --asdeps                 | Install packages as dependencies of another package                 |
| yaloc   | yaourt -Qi                         | Display information about a package in the local database           |
| yalocs  | yaourt -Qs                         | Search for packages in the local database                           |
| yalst   | yaourt -Qe                         | List installed packages including from AUR (tagged as "local")      |
| yamir   | yaourt -Syy                        | Force refresh of all package lists after updating mirrorlist        |
| yaorph  | yaourt -Qtd                        | Remove orphans using yaourt                                         |
| yare    | yaourt -R                          | Remove packages, keeping its settings and dependencies              |
| yarem   | yaourt -Rns                        | Remove packages, including its settings and unneeded dependencies   |
| yarep   | yaourt -Si                         | Display information about a package in the repositories             |
| yareps  | yaourt -Ss                         | Search for packages in the repositories                             |
| yaupd   | yaourt -Sy && sudo abs && sudo aur | Update and refresh local package, ABS and AUR databases             |
| yaupd   | yaourt -Sy && sudo abs             | Update and refresh the local package and ABS databases              |
| yaupd   | yaourt -Sy && sudo aur             | Update and refresh the local package and AUR databases              |
| yaupd   | yaourt -Sy                         | Update and refresh the local package database                       |
| yaupg   | yaourt -Syua                       | Sync with repositories before upgrading all packages (from AUR too) |
| yasu    | yaourt -Syua --no-confirm          | Same as `yaupg`, but without confirmation                           |
| upgrade | yaourt -Syu                        | Sync with repositories before upgrading packages                    |

#### PACMAN

| Alias        | Command                                 | Description                                                  |
|--------------|-----------------------------------------|--------------------------------------------------------------|
| pacin        | sudo pacman -S                          | Install packages from the repositories                       |
| pacins       | sudo pacman -U                          | Install a package from a local file                          |
| pacinsd      | sudo pacman -S --asdeps                 | Install packages as dependencies of another package          |
| pacloc       | pacman -Qi                              | Display information about a package in the local database    |
| paclocs      | pacman -Qs                              | Search for packages in the local database                    |
| paclsorphans | sudo pacman -Qdt                        | List all orphaned packages                                   |
| pacmir       | sudo pacman -Syy                        | Force refresh of all package lists after updating mirrorlist |
| pacre        | sudo pacman -R                          | Remove packages, keeping its settings and dependencies       |
| pacrem       | sudo pacman -Rns                        | Remove packages, including its settings and dependencies     |
| pacrep       | pacman -Si                              | Display information about a package in the repositories      |
| pacreps      | pacman -Ss                              | Search for packages in the repositories                      |
| pacrmorphans | sudo pacman -Rs $(pacman -Qtdq)         | Delete all orphaned packages                                 |
| pacupd       | sudo pacman -Sy && sudo abs && sudo aur | Update and refresh the local package, ABS and AUR databases  |
| pacupd       | sudo pacman -Sy && sudo abs             | Update and refresh the local package and ABS databases       |
| pacupd       | sudo pacman -Sy && sudo aur             | Update and refresh the local package and AUR databases       |
| pacupd       | sudo pacman -Sy                         | Update and refresh the local package database                |
| pacupg       | sudo pacman -Syu                        | Sync with repositories before upgrading packages             |
| upgrade      | sudo pacman -Syu                        | Sync with repositories before upgrading packages             |

| Function       | Description                                          |
|----------------|------------------------------------------------------|
| pacdisowned    | List all disowned files in your system               |
| paclist        | List all installed packages with a short description |
| pacmanallkeys  | Get all keys for developers and trusted users        |
| pacmansignkeys | Locally trust all keys passed as parameters          |

---

## Contributors

- Benjamin Boudreau - dreurmail@gmail.com
- Celso Miranda - contacto@celsomiranda.net
- KhasMek - Boushh@gmail.com
- Martin Putniorz - mputniorz@gmail.com
- MatthR3D - matthr3d@gmail.com
- ornicar - thibault.duplessis@gmail.com

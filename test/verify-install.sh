#!/usr/bin/env bash
set -eu

echo "Verifying installation..."

commands=(
    "go version"
    "nvim --version"
    "mise --version"
    "jj --version"
    "gh --version"
    "bat --version"
    "rg --version"
    "stow --version"
)

# Go utilities installed via go install
go_utils=(
    "wgo"
    "dlv"
    "pp"
    "benchstat"
    "pkgsite"
    "stress"
)

failed=0
for cmd in "${commands[@]}"; do
    if $cmd > /dev/null 2>&1; then
        echo "✓ $cmd"
    else
        echo "✗ $cmd FAILED"
        failed=1
    fi
done

echo ""
echo "Verifying Go utilities..."
for util in "${go_utils[@]}"; do
    if command -v "$util" > /dev/null 2>&1; then
        echo "✓ $util"
    else
        echo "✗ $util not found"
        failed=1
    fi
done

exit $failed

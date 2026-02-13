#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# ANSI colors
reset='\033[0m'
bold='\033[1m'
dim='\033[2m'
green='\033[32m'
red='\033[31m'
yellow='\033[33m'
cyan='\033[36m'
magenta='\033[35m'
blue='\033[34m'

# Extract fields
model_name=$(echo "$input" | jq -r '.model.display_name')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
loc_added=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
loc_removed=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
duration=$(echo "$input" | jq -r '.cost.total_api_duration_ms // empty')

# If no context usage yet, show model name only
if [ -z "$used_pct" ]; then
    printf "${bold}${magenta}%s${reset}" "$model_name"
    exit 0
fi

# Round the percentage to integer
used_pct_int=$(printf "%.0f" "$used_pct")

# Pick bar color based on usage
if [ "$used_pct_int" -lt 50 ]; then
    bar_color="$green"
elif [ "$used_pct_int" -lt 80 ]; then
    bar_color="$yellow"
else
    bar_color="$red"
fi

# Create progress bar (20 characters wide)
bar_width=20
filled=$(( (used_pct_int * bar_width) / 100 ))
empty=$(( bar_width - filled ))

bar_filled=""
bar_empty=""
for ((i=0; i<filled; i++)); do
    bar_filled+="█"
done
for ((i=0; i<empty; i++)); do
    bar_empty+="░"
done

# Format cost
cost_str=""
if [ -n "$cost" ]; then
    cost_str=$(printf '$%.2f' "$cost")
fi

# Format duration as seconds
duration_str=""
if [ -n "$duration" ]; then
    duration_s=$(printf "%.1f" "$(echo "$duration / 1000" | bc -l)")
    duration_str="${duration_s}s"
fi

# Output
printf "${bold}${magenta}%s${reset} " "$model_name"
printf "${bar_color}%s${dim}%s${reset} ${bar_color}%d%%${reset}" "$bar_filled" "$bar_empty" "$used_pct_int"
printf " ${dim}│${reset} ${green}+%s${reset}${dim}/${reset}${red}-%s${reset}" "$loc_added" "$loc_removed"
printf " ${dim}│${reset} ${yellow}%s${reset}" "$cost_str"
printf " ${dim}│${reset} ${cyan}%s${reset}" "$duration_str"

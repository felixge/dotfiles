FROM ubuntu:24.04

# Set working directory where dotfiles will be mounted
WORKDIR /opt/dotfiles

# Default command
CMD ["/bin/bash"]
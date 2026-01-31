.PHONY: test-ubuntu test-ubuntu-shell

# Build and test Ubuntu installation
test-ubuntu:
	docker build -f test/Dockerfile.ubuntu -t dotfiles-test-ubuntu .

# Interactive shell for debugging
test-ubuntu-shell:
	docker run -it --rm -v $(PWD):/home/testuser/dotfiles dotfiles-test-ubuntu bash

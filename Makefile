.PHONY: install
install:
	stow $$(echo */ | xargs -n1 basename)

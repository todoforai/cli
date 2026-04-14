.PHONY: help build bump-version deploy-tag

help:
	@echo "  make build             - Build CLI"
	@echo "  make bump-version      - Bump version by 0.0.1"
	@echo "  make deploy-tag        - Bump, commit, tag, push (triggers npm publish)"

build:
	bun run build

bump-version:
	@VERSION=$$(grep -oP '"version": "\K[0-9]+\.[0-9]+\.[0-9]+' package.json) && \
	MAJOR=$$(echo $$VERSION | cut -d. -f1) && \
	MINOR=$$(echo $$VERSION | cut -d. -f2) && \
	PATCH=$$(echo $$VERSION | cut -d. -f3) && \
	NEW_PATCH=$$((PATCH + 1)) && \
	NEW_VERSION="$$MAJOR.$$MINOR.$$NEW_PATCH" && \
	echo "Bumping $$VERSION -> $$NEW_VERSION" && \
	sed -i "s/\"version\": \"$$VERSION\"/\"version\": \"$$NEW_VERSION\"/" package.json && \
	git add package.json && \
	git commit -m "Bump version to $$NEW_VERSION" && \
	git push origin main

deploy-tag: bump-version
	@VERSION=$$(grep -oP '"version": "\K[0-9]+\.[0-9]+\.[0-9]+' package.json) && \
	git tag -a "v$$VERSION" -m "Release v$$VERSION" && \
	git push origin "v$$VERSION"

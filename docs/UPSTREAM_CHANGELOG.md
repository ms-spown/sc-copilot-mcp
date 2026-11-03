# [1.5.0](https://github.com/voidput/SCMCP/compare/v1.4.1...v1.5.0) (2026-09-05)


### Features

* SCMCP_TOOLS scopes which tools this server advertises ([01bb910](https://github.com/voidput/SCMCP/commit/01bb91027aa56006a0b9ce53c426048d2f95825e))

## [1.4.1](https://github.com/voidput/SCMCP/compare/v1.4.0...v1.4.1) (2026-09-05)


### Bug Fixes

* sc_get_vocabulary silently returned fewer terms than it claimed ([2120607](https://github.com/voidput/SCMCP/commit/2120607accf5a65f01fbac098e8db4afbd2e1523))

# [1.4.0](https://github.com/voidput/SCMCP/compare/v1.3.0...v1.4.0) (2026-09-05)


### Features

* extend sc_get_vocabulary with weapons, attachments and item categories ([2e5bbc1](https://github.com/voidput/SCMCP/commit/2e5bbc146efab0a53b084f1145be9dc0f5b9ea6f))

# [1.3.0](https://github.com/voidput/SCMCP/compare/v1.2.0...v1.3.0) (2026-09-05)


### Features

* add uex_search_marketplace tool ([f960c40](https://github.com/voidput/SCMCP/commit/f960c404e6585ceddae0c48ecdd74b98b700db37))

# [1.2.0](https://github.com/voidput/SCMCP/compare/v1.1.1...v1.2.0) (2026-09-05)


### Features

* add sc_get_vocabulary, merging local gamedata with the public API ([4e465a5](https://github.com/voidput/SCMCP/commit/4e465a5de63743d8f83510cb66e7636dd62409ab))

## [1.1.1](https://github.com/voidput/SCMCP/compare/v1.1.0...v1.1.1) (2026-09-05)


### Bug Fixes

* **ci:** build arm64 without emulation ([2c34f74](https://github.com/voidput/SCMCP/commit/2c34f7442025e940195ca1f713724d52a3865952))

# [1.1.0](https://github.com/voidput/SCMCP/compare/v1.0.0...v1.1.0) (2026-09-05)


### Bug Fixes

* make tool output parseable, and add tests that catch why it was not ([f3fdcf8](https://github.com/voidput/SCMCP/commit/f3fdcf836cfb59c9498b3433f330d17c15ad6782))
* **security:** clear dependency advisories and harden the image ([aecdcbf](https://github.com/voidput/SCMCP/commit/aecdcbfb11252a4bdc85824a8b3d38cbd0368bcb))
* use page[size] for wiki pagination, which ignores per_page ([1d654a2](https://github.com/voidput/SCMCP/commit/1d654a2a673189cb64ed2da137452bdbea65c0d4))


### Features

* add ship pricing/comparison tools and model-routing policy ([b91567f](https://github.com/voidput/SCMCP/commit/b91567f98736fc7f19005c5f344c0301fc1a5a42))
* add ship vendor lookup and terminal inventory tools ([5b43c9e](https://github.com/voidput/SCMCP/commit/5b43c9e5485b402ca4d270f762d7b6ea578c2e4a))
* add ship/weapon/component browsing and patch snapshot diffing ([33de79b](https://github.com/voidput/SCMCP/commit/33de79b6b158e73867870a7ae2b4ef040d0784fc))
* compare game data between any two patch versions ([e9e5edb](https://github.com/voidput/SCMCP/commit/e9e5edb67a5a79191e1f0329065f34dd5a119f67))
* read locally extracted game data for domains no API exposes ([46d3557](https://github.com/voidput/SCMCP/commit/46d3557f4d5d92e338d0defed4e8271c4c8b65de))
* read patch history from our own dump repo ([96ab167](https://github.com/voidput/SCMCP/commit/96ab1675f018c5bd91f0451e1ed4e3705cf8459f))

# 1.0.0 (2026-04-07)


### Bug Fixes

* init ([19b56c5](https://github.com/voidput/SCMCP/commit/19b56c5b6b0ae024d0eb8e8cf8fd6e781ba36bcc))


### Features

* add linting, formatting, semantic-release, makefile, and install script ([34e6676](https://github.com/voidput/SCMCP/commit/34e66764987ed4514e3348dced317b93fa6166a9))
* add Star Citizen Tools integration for Wikelo and general search ([79682a8](https://github.com/voidput/SCMCP/commit/79682a8ddc0dd15882483a0dfc4698793bf2f96a))
* initial setup of MCP with Docker and caching optimizations ([c8e7e68](https://github.com/voidput/SCMCP/commit/c8e7e6840fd5327640e7a8f9b7f19aa7e223ae73))

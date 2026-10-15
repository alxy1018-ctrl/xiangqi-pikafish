本项目自带第三方象棋引擎与神经网络权重，来源与授权如下。
This project bundles a third-party chess engine and neural-network weights.
Their origin and licence are recorded here.

================================================================================
Pikafish（皮卡鱼）
================================================================================

文件 / Files
    engine/Pikafish-Windows-x86-64-universal.exe   7,421,952 字节
    engine/pikafish.nnue                          50,706,378 字节

版本 / Version
    Pikafish 2026-09-25

来源 / Source
    官网        https://pikafish.com
    GitHub      https://github.com/official-pikafish/Pikafish
    Releases    https://github.com/official-pikafish/Pikafish/releases

授权 / Licence
    引擎与权重免费发布，协议原文见 engine/NNUE-License.txt。两条限制：

    1. 仅限用于合法用途。
       任何超出合法范围的使用（如作弊）所造成的后果或责任由用户自行承担。
       Only for legal use. Any use beyond the legal scope (e.g. online cheating)
       is the user's own responsibility.

    2. 未经允许不得用于商业用途。
       No commercial use without permission.

本仓库的再分发 / Redistribution in this repository
    - 文件未经任何修改，SHA256 与官方发布一致。
    - 仅用于非商业目的（开源项目自带依赖）。
    - 商用授权请走官方渠道：https://www.pikafish.com/list.html
    - 引擎会随官方版本更新；需要最新版请从上面的 Releases 地址获取。

    The files are unmodified and redistributed for non-commercial purposes only.
    For commercial licensing, contact the Pikafish project via the link above.

================================================================================
本项目自身 / This project
================================================================================

xiangqi（中国象棋对弈页）的源码位于仓库根目录，与上面的引擎文件相互独立。
把 engine/ 目录整个删掉、改用环境变量 XQ_ENGINE 指向自己的引擎，本项目照常工作。

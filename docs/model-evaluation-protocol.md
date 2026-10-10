# HGST 评估协议修正（2026-10-10）

此前研究脚本把同一批样本同时用作验证集和测试集，并将验证指标以 test_* 返回；准确率并列时还分别取不同轮次的最大指标。自监督预训练也读取了全部样本。因此旧日志中的相关分数不能作为严格独立测试结果引用。本次修正代码与验证流程，不修改已有权重，不生成新的性能数字。

## 研究交叉验证

HGST-main/pretrain_and_tune.py 的默认流程：

1. 按标签分层划分外层训练集与测试集；外层随机种子使用 --seed。
2. 从外层训练集中再分层保留验证集，默认比例为 0.2，可通过 --validation_fraction 或 --validation-fraction 设置。默认五折下，训练、验证、测试约占总样本的 64%、16%、20%。
3. 每折重新创建编码器。图增强、Wasserstein 相似度和 SSL 的所有训练输入仅来自该折训练集。验证和测试只做单样本预处理与冻结编码器推理，编码器处于 eval 模式，不更新参数或 BatchNorm 统计。
4. 分类头只用训练集更新参数。只根据验证准确率选择快照，准确率并列保留最早轮次，不混合各轮次的指标。即使首次验证准确率为零，也保留实际模型快照。
5. 恢复该快照后，测试集只评估一次；accuracy、宏平均 recall/precision/F1、AUC、specificity 均来自同一组预测。没有负类时 specificity、缺少类别时 AUC 明确为 NaN，不伪造为零。

train_engine.py 的 graph_classification_evaluation 和 MLP_tune 原函数签名及 test_* 返回键保留。test_* 现在代表真正测试指标；额外 val_* 代表所选快照的验证指标。best_val_epoch 保留从零开始的编号。

每折预训练权重使用 *_fold_1.pth 等文件名。原有 --save_model_name 会在扩展名前增加折编号，避免五个模型互相覆盖。evaluation_manifest.json 记录随机种子、各组原始样本索引、所选轮次及对应指标。

如果显式使用 --pretrain False --pre_model <旧权重>，每折仍建立新实例，但外部权重是否见过测试样本无法由文件名证明。该流程输出 external_unverified 来源标识、警告和 end_to_end_test_verified=false；只能作为分类头留出评估，不能宣称端到端独立测试。默认逐折 SSL 的来源标识为 fold_train_only。

## 部署权重打包

backend.app.services.hgst_runtime.service.build_hgst_deployment_bundle 的公开参数与推理权重契约保留。默认分类头改为独立 train/validation/test 三组，同样只通过验证准确率选快照，再评估一次测试集。

所有参数快照使用 detach().cpu().clone()。CPU 上 detach().cpu() 可能仍共享参数存储，clone 保证后续优化不会覆盖已选择的快照。

部署函数仍使用传入的外部编码器，无法证明其数据来源，因此新 bundle 明确记录：

- pretraining_scope=external_unverified。
- evaluation_scope=classifier_holdout_external_encoder。
- end_to_end_test_verified=false。
- val_accuracy、best_val_epoch 以及 test_accuracy_classifier_holdout 等字段；测试指标名称标明只评估分类头留出数据。
- 分组样本数、随机种子和最早轮次的并列规则。

--train-on-full-dataset 保留，只输出 train_accuracy_full；它没有验证集或独立测试结果。现有旧 bundle 可继续加载，其旧指标和未知来源不会因代码更新自动成为可靠的新评估。

## 推理模式

没有调用的 _run_lightweight_timeseries_inference 和其 synthetic-anchor LogisticRegression 已删除。真实入口仍为 predict_timeseries_file；real 缺依赖或权重时返回错误，auto 明确降级至标记为演示的 Mock，mock 始终标记为演示。相关模式解析、上传响应和错误边界未改变。

## 已执行验证与限制

新增的 10 项回归检查先出现 10 个预期失败，再与现有模式和上传检查一起通过：

~~~text
.venv/Scripts/python.exe -B -m pytest backend/tests/test_hgst_evaluation.py backend/tests/test_model_modes.py backend/tests/test_model_upload.py -q
25 passed
~~~

四个修改的模型模块均通过 Python 语法解析。本机当前 .venv 没有 torch 和 dhg，因此没有运行真实 SSL、分类头训练或真实 HGST 推理。纯 NumPy/sklearn 检查验证数据分组、每折新实例、训练输入边界、快照选择、参数存储隔离、一次测试及指标计算；它们不能代替真实训练运行。

获得新的可引用分数仍需在含 torch/dhg 的环境按修正流程重新训练，并保存新日志与 evaluation_manifest.json。已有 .pth/.pt 文件在本次修复中未改写。
